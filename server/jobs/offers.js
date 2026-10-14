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
 * An offer that does not match the contract is left out (Network would refuse the whole report for one bad offer).
 * Without a reporter (no Network credentials) nothing is reported.
 */
const { validate } = require('openvibe-contracts');
const { json } = require('../util');

const CONTRACT = 'platform.resource-offer@1';
const CLASSES = new Set(['function', 'code', 'browser', 'linux', 'desktop', 'gpu']);

function createOfferPublisher({ db, hub, reporter = null, log = console, now = () => Date.now(), intervalMs = 60_000, settleMs = 2_000 }) {
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
        return offers;
    }

    /** Report the whole set now (one report at a time; a change during one reports again after it). */
    async function publish() {
        if (!reporter) return null;
        if (running) { again = true; return running; }
        running = (async () => {
            try {
                return await reporter.report(await build());
            } catch (e) {
                log.warn(`[Bot] offers report: ${e.message}`);
                return null;
            } finally {
                running = null;
                if (again) { again = false; poke(); }
            }
        })();
        return running;
    }

    /** A device changed: report a moment later (changes in a burst are reported once). Only once started. */
    function poke() {
        if (!reporter || !timer || soon) return;
        soon = setTimeout(() => { soon = null; void publish(); }, settleMs);
        if (soon.unref) soon.unref();
    }

    function start() {
        if (!reporter || timer) return;
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
    return { build, publish, start, stop, poke };
}

module.exports = { createOfferPublisher };
