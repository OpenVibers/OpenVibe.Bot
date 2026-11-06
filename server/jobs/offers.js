'use strict';
/**
 * The worker offers Bot reports to Network (plan T14/T16, contracts 0.161.0, ADR-046). Every live device that runs a
 * job worker (OpenVibe.Node status.capabilities.worker.runtime_classes) is a person's own machine: one
 * platform.resource-offer@1 per device, kind `node`, trust `user-owned`, naming its owner, advertising
 * `worker:<class>` for each class, `up` while the device is connected and `down` otherwise. The set is reported whole
 * as source `bot` (Network marks an offer missing from a later report down), once a minute and a moment after a device
 * comes or goes or changes what it advertises.
 *
 *   createOfferPublisher({ db, hub, reporter, log, now, intervalMs, settleMs }) → { build, publish, start, stop, poke }
 *
 * The same set carries a community AI offer (the design's "Offer to the network"): a machine whose OpenVibe.Node ai
 * plugin advertises `capabilities.ai.offer.enabled` with models, hours, concurrency, a credit price and an audience is
 * one user-owned provider offer, `ai:<device>`, whose detail.kind is `ai` and whose health follows its connection and
 * its own open/ready flags. Network validates the detail; OpenVibe.AI reads the internal list and places only requests
 * that opt in to community capacity on it.
 *
 * An offer that does not match the contract is left out (Network would refuse the whole report for one bad offer).
 * Without a reporter (no Network credentials) nothing is reported.
 */
const { validate } = require('openvibe-contracts');
const { json } = require('../util');

const CONTRACT = 'platform.resource-offer@1';
const CLASSES = new Set(['function', 'code', 'browser', 'linux', 'desktop', 'gpu']);

/** The ai plugin's offer, or null when it is off or incomplete (an incomplete one is left out, never half reported). */
function aiOfferOf(capabilities) {
    // The Node reports each plugin's describe under its name, so the ai plugin's {ai: {models, offer}} arrives as
    // capabilities.ai.ai; a direct capabilities.ai.offer is accepted too (an older/other reporter).
    let ai = json(capabilities, {}).ai;
    if (ai && ai.ai) ai = ai.ai;
    const offer = ai && ai.offer;
    if (!offer || offer.enabled !== true || !Array.isArray(offer.models) || !offer.models.length) return null;
    if (!offer.hours || typeof offer.hours !== 'object' || !offer.price || typeof offer.price !== 'object') return null;
    if (!Number.isInteger(offer.concurrency) || offer.concurrency < 1 || offer.concurrency > 8) return null;
    if (!['everyone', 'followers', 'group'].includes(offer.audience)) return null;
    if (offer.audience === 'group' && (typeof offer.group !== 'string' || !offer.group.trim())) return null;
    for (const key of ['in_per_million', 'out_per_million']) {
        if (typeof offer.price[key] !== 'number' || !Number.isFinite(offer.price[key]) || offer.price[key] < 0) return null;
    }
    return offer;
}

function createOfferPublisher({ db, hub, reporter = null, aiReporter = null, log = console, now = () => Date.now(), intervalMs = 60_000, settleMs = 2_000, firstPartyOwners = [] }) {
    const firstParty = new Set(firstPartyOwners);
    let timer = null;
    let soon = null;
    let running = null;
    let again = false;

    /** The offers of every live worker device, owner and connection included. */
    async function build() {
        const rows = await db.many(
            `SELECT d.id, d.capabilities, d.owner_subject, r.owner_subject AS robot_owner
             FROM devices d LEFT JOIN robots r ON r.id = d.robot_ids ->> 0
             WHERE d.revoked_at IS NULL AND d.capabilities -> 'worker' IS NOT NULL
             ORDER BY d.id`);
        const at = new Date(now()).toISOString();
        const offers = [];
        for (const row of rows) {
            const worker = json(row.capabilities, {}).worker || {};
            const classes = (Array.isArray(worker.runtime_classes) ? worker.runtime_classes : []).filter((c) => CLASSES.has(c));
            const owner = row.owner_subject || row.robot_owner;
            if (!classes.length || !owner) continue;
            const offer = {
                offer_id: `node:${row.id}`, kind: 'node', node_id: row.id, provider: 'self', region: 'home',
                trust: 'user-owned', owner,
                capabilities: classes.map((c) => `worker:${c}`),
                health: { status: hub && hub.isOnline(row.id) ? 'up' : 'down', checked_at: at },
                pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 },
                updated_at: at,
            };
            const v = validate(CONTRACT, offer);
            if (!v.valid) {
                log.warn(`[Bot] offers: ${row.id} does not match ${CONTRACT}, left out`);
                continue;
            }
            offers.push(offer);
        }
        // Desk hosts that serve other people (contracts 0.223.0, Desks plan D6): a browser desk per session for anyone,
        // each in its own sandbox there, placed by OpenVibe.Run and leased through Bot (api/desk-leases.js). Community,
        // or first-party for the owners configured as OpenVibe's own (BOT_FIRST_PARTY_DESK_OWNERS).
        const shared = await db.many(
            `SELECT d.id, d.capabilities, d.owner_subject, r.owner_subject AS robot_owner
             FROM devices d LEFT JOIN robots r ON r.id = d.robot_ids ->> 0
             WHERE d.revoked_at IS NULL AND d.shared_desks = true ORDER BY d.id`);
        for (const row of shared) {
            const desk = ((json(row.capabilities, {}).computer || {}).desk) || {};
            if (desk.isolation !== 'sandbox' || !Array.isArray(desk.kinds) || !desk.kinds.includes('browser')) continue;
            const owner = row.owner_subject || row.robot_owner;
            const offer = {
                offer_id: `desk:${row.id}`, kind: 'node', node_id: row.id, provider: 'self', region: 'home',
                trust: firstParty.has(owner) ? 'first-party' : 'community',
                capabilities: ['worker:browser'],
                health: { status: hub && hub.isOnline(row.id) ? 'up' : 'down', checked_at: at },
                pricing: { model: 'per-second', marginal_usd_per_unit: 0, unit: 'desk-second' },
                updated_at: at,
            };
            const v = validate(CONTRACT, offer);
            if (!v.valid) { log.warn(`[Bot] offers: desk host ${row.id} does not match ${CONTRACT}, left out`); continue; }
            offers.push(offer);
        }
        return offers;
    }

    /** The community AI offers: one per machine whose Node ai plugin advertises an enabled offer. */
    async function buildAi() {
        const rows = await db.many(
            `SELECT d.id, d.capabilities, d.owner_subject, r.owner_subject AS robot_owner
             FROM devices d LEFT JOIN robots r ON r.id = d.robot_ids ->> 0
             WHERE d.revoked_at IS NULL AND (d.capabilities -> 'ai' -> 'ai' -> 'offer' ->> 'enabled' = 'true'
                 OR d.capabilities -> 'ai' -> 'offer' ->> 'enabled' = 'true')
             ORDER BY d.id`);
        const at = new Date(now()).toISOString();
        const offers = [];
        for (const row of rows) {
            const offer = aiOfferOf(row.capabilities);
            const owner = row.owner_subject || row.robot_owner;
            if (!offer || !owner) continue;
            const online = Boolean(hub && hub.isOnline(row.id));
            offers.push({
                offer_id: `ai:${row.id}`, machine_id: row.id, owner,
                models: offer.models.slice(0, 40),
                hours: { start: offer.hours.start, end: offer.hours.end, tz: offer.hours.tz },
                concurrency: offer.concurrency,
                price: { in_per_million: offer.price.in_per_million, out_per_million: offer.price.out_per_million },
                audience: offer.audience, group: offer.audience === 'group' ? offer.group : null,
                ready: online && offer.ready === true,
                health: { status: online && offer.ready === true ? 'up' : 'down', checked_at: at },
            });
        }
        return offers;
    }

    /** Report the whole set now (one report at a time; a change during one reports again after it). */
    async function publish() {
        if (!reporter && !aiReporter) return null;
        if (running) { again = true; return running; }
        running = (async () => {
            const out = {};
            try {
                if (reporter) out.offers = await reporter.report(await build());
            } catch (e) { log.warn(`[Bot] offers report: ${e.message}`); }
            try {
                if (aiReporter) out.ai = await aiReporter.report(await buildAi());
            } catch (e) { log.warn(`[Bot] ai offers report: ${e.message}`); }
            return out;
        })().finally(() => {
            running = null;
            if (again) { again = false; poke(); }
        });
        return running;
    }

    /** A device changed: report a moment later (changes in a burst are reported once). Only once started. */
    function poke() {
        if ((!reporter && !aiReporter) || !timer || soon) return;
        soon = setTimeout(() => { soon = null; void publish(); }, settleMs);
        if (soon.unref) soon.unref();
    }

    function start() {
        if ((!reporter && !aiReporter) || timer) return;
        timer = setInterval(() => { void publish(); }, intervalMs);
        if (timer.unref) timer.unref();
        poke();
    }
    function stop() {
        if (timer) clearInterval(timer);
        if (soon) clearTimeout(soon);
        timer = null;
        soon = null;
    }
    return { build, buildAi, publish, start, stop, poke };
}

module.exports = { createOfferPublisher, aiOfferOf };
