'use strict';
/**
 * Desk leases for OpenVibe.Run's sessions (contracts 0.223.0, capability bot.desk.session; the Desks plan's D6). Run,
 * with a service token naming the session's person in X-OV-Subject, leases one named browser desk on a machine:
 *
 *   GET    /api/v1/desk-hosts                              where a desk may go for this person: their own machines
 *                                                          (where they let agents use them) and desk hosts that serve
 *                                                          other people, each with its trust class and its room
 *   POST   /api/v1/machines/:id/desk-leases                bot.desk-lease-create-request@1 → 201 bot.desk-lease@1: the
 *                                                          desk is started (kind browser, the lease's size)
 *   GET    /api/v1/machines/:id/desk-leases/:desk          the lease, to its person only
 *   POST   /api/v1/machines/:id/desk-leases/:desk/commands screen, input or browser on that desk alone (bot.command@1
 *                                                          without desk) → bot.command-result@1's fields
 *   DELETE /api/v1/machines/:id/desk-leases/:desk          the desk is stopped and the lease ends
 *
 * A machine takes a lease when it is the person's own and its owner turned on "Let my agent use this computer", or when
 * its owner offers its desks to other people (shared_desks) and its Node runs every desk in its own sandbox (describe
 * desk.isolation "sandbox", Node v0.32.0). Anything else is 404, never confirmed to exist. A leased desk is the
 * session's alone: the machine's own routes refuse it (api/v1.js), and on a shared host nothing but browser desks runs.
 */
const express = require('express');
const { validate } = require('openvibe-contracts');
const { fail, userSubject } = require('../util');

const CAPABILITY = 'bot.desk.session';
const RUN = 'svc:run';
const MACHINE_RE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const DESK_RE = /^desk-[a-z0-9][a-z0-9-]{0,23}$/;
const ACTS = new Set(['screen', 'input', 'browser']);
const MAX_DESKS_CAP = 10;   // the computer plugin's own cap on max_desks; a browser desk counts as half

/** The refusal codes a command can come back with, as HTTP statuses (as api/v1.js commandRefusalStatus). */
function refusalStatus(code) {
    if (code === 'bot.forbidden' || code === 'bot.not_an_operator') return 403;
    if (code === 'bot.device_offline' || code === 'bot.command_pending' || code === 'bot.computer_off' || code === 'bot.person_driving') return 409;
    return 422;
}

function router({ domain, apiAuth, hub, config = {}, limit = (req, res, next) => next() }) {
    const r = express.Router();
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    // The owners whose shared desk hosts are OpenVibe's own (first-party); every other shared host is community.
    const firstParty = new Set((config.deskHosts && config.deskHosts.firstPartyOwners) || []);

    /** Only Run, with bot.desk.session, acting for a person (X-OV-Subject). → that person's subject */
    function runFor(req) {
        if (req.principal.kind === 'anonymous') fail(401, 'bot.sign_in', 'sign in to do that');
        if (req.principal.kind !== 'service' || req.principal.sub !== RUN) fail(403, 'bot.forbidden', 'desk leases are OpenVibe.Run\'s, for its sessions');
        if (!apiAuth.granted(req.principal, CAPABILITY)) fail(403, 'capability.denied', `${CAPABILITY} not granted`);
        const s = req.headers['x-ov-subject'];
        if (!s) fail(422, 'bot.invalid_input', 'a session acts for a person (X-OV-Subject)');
        return userSubject(s, 'subject');
    }

    const sensors = (deviceId) => {
        const st = hub.deviceState(deviceId) || {};
        return st.telemetry && st.telemetry.sensors && typeof st.telemetry.sensors === 'object' ? st.telemetry.sensors : {};
    };
    const browserDesks = (offered) => !!(offered && offered.desk && Array.isArray(offered.desk.kinds) && offered.desk.kinds.includes('browser') && offered.desk.named === true);
    const sandboxed = (offered) => !!(offered && offered.desk && offered.desk.isolation === 'sandbox');

    /**
     * How a person may use a machine for a session, or null: { device, shared, trust }. Their own machine where agents
     * may use it; another's only when its owner shares its desks and its Node sandboxes every one.
     */
    async function usable(device, subject) {
        if (!device || device.revoked_at) return null;
        const offered = hub.computerOf(device.id);
        if (!browserDesks(offered)) return null;
        const owner = await domain.devices.ownerOf(device);
        if (owner === subject && device.agent_computer) return { device, shared: false, trust: 'user-owned', offered };
        if (device.shared_desks && sandboxed(offered)) return { device, shared: true, trust: firstParty.has(owner) ? 'first-party' : 'community', offered };
        return null;
    }
    /** Room for one more browser desk: the plugin's max_desks counts a browser desk as half. */
    async function room(device, offered) {
        const max = Math.min(MAX_DESKS_CAP, Number(offered.desk.max_desks) || 1) * 2;
        const running = Number.isInteger(sensors(device.id).computer_desks) ? sensors(device.id).computer_desks : 0;
        const leased = await domain.deskLeases.count(device.id);
        return { max, used: Math.max(running, leased), free: Math.max(0, max - Math.max(running, leased)) };
    }

    r.get('/desk-hosts', limit, wrap(async (req, res) => {
        const subject = runFor(req);
        const own = await domain.machines.list(subject);
        const shared = await domain.machines.listSharedDesks();
        const seen = new Set();
        const hosts = [];
        for (const d of [...own, ...shared]) {
            if (seen.has(d.id)) continue;
            seen.add(d.id);
            const u = await usable(d, subject);
            if (!u) continue;
            const online = !!(hub.isOnline && hub.isOnline(d.id));
            const rm = await room(d, u.offered);
            hosts.push({ machine_id: d.id, trust: u.trust, shared: u.shared, online, region: null, max_browser_desks: rm.max, used: rm.used, free: online ? rm.free : 0,
                ...(u.shared ? { limits: u.offered.desk.limits || null } : { name: d.name || null }) });
        }
        res.set('Cache-Control', 'no-store').json({ hosts });
    }));

    async function machineFor(req, subject) {
        const id = String(req.params.id || '');
        if (!MACHINE_RE.test(id)) fail(404, 'bot.device_not_found', 'no such machine for you');
        const u = await usable(await domain.devices.get(id), subject);
        if (!u) fail(404, 'bot.device_not_found', 'no such machine for you');
        return u;
    }
    async function leaseFor(req, subject) {
        const u = await machineFor(req, subject);
        const desk = String(req.params.desk || '');
        const lease = DESK_RE.test(desk) ? await domain.deskLeases.get(u.device.id, desk) : null;
        if (!lease || lease.owner !== `user:${subject}`) fail(404, 'bot.lease_not_found', 'no such desk lease for you');
        return { ...u, lease };
    }
    const principalFor = (req, subject) => ({ ...req.principal, subject });

    r.post('/machines/:id/desk-leases', limit, express.json({ limit: '8kb' }), wrap(async (req, res) => {
        const subject = runFor(req);
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const check = validate('bot.desk-lease-create-request@1', body);
        if (!check.valid) fail(422, 'bot.invalid_input', `invalid lease: ${(check.errors && check.errors[0] && check.errors[0].message) || 'bad value'}`.slice(0, 300));
        const u = await machineFor(req, subject);
        const owner = `user:${subject}`;
        const mine = await domain.deskLeases.forSession(body.session);
        if (mine) {
            if (mine.machine_id === u.device.id && mine.desk === body.desk && mine.owner === owner) return res.status(200).json(mine);
            fail(409, 'bot.lease_conflict', 'that session holds another desk');
        }
        if (!(hub.isOnline && hub.isOnline(u.device.id))) fail(409, 'bot.device_offline', 'the machine is offline');
        if ((await room(u.device, u.offered)).free < 1) fail(409, 'bot.machine_busy', 'the machine has no room for another desk right now');
        const width = Number.isInteger(body.width) ? body.width : 1280;
        const height = Number.isInteger(body.height) ? body.height : 800;
        const lease = await domain.deskLeases.create({ deviceId: u.device.id, desk: body.desk, session: body.session, owner, width, height, shared: u.shared });
        if (!lease) fail(409, 'bot.desk_busy', 'that desk is in use');
        // The desk starts now; a machine that refuses it gives the lease back at once.
        let result;
        try {
            result = await hub.machineCommand(u.device.id, principalFor(req, subject), subject, {
                id: `lease-${body.session}`.slice(0, 64), kind: 'desk', ms: 30000,
                value: { action: 'start', desk: body.desk, kind: 'browser', width, height },
            });
        } catch (e) { result = { result: 'refused', code: 'bot.device_offline', reason: e.message }; }
        if (!result || result.result !== 'ack') {
            await domain.deskLeases.remove(u.device.id, body.desk);
            const code = result && result.code ? result.code : result && result.result === 'nack' ? 'bot.desk_failed' : 'bot.device_offline';
            fail(code === 'bot.desk_failed' ? 502 : refusalStatus(code), code, (result && result.reason) || 'the machine did not start the desk');
        }
        res.status(201).json(lease);
    }));

    r.get('/machines/:id/desk-leases/:desk', limit, wrap(async (req, res) => {
        const subject = runFor(req);
        const { lease } = await leaseFor(req, subject);
        res.set('Cache-Control', 'no-store').json(lease);
    }));

    r.post('/machines/:id/desk-leases/:desk/commands', limit, express.json({ limit: '64kb' }), wrap(async (req, res) => {
        const subject = runFor(req);
        const { device, lease } = await leaseFor(req, subject);
        const kind = String((req.body && req.body.kind) || '');
        const value = req.body && req.body.value && typeof req.body.value === 'object' && !Array.isArray(req.body.value) ? req.body.value : null;
        if (!ACTS.has(kind) || !value) fail(422, 'bot.invalid_input', 'kind is screen, input or browser, with a value');
        if ('desk' in value) fail(422, 'bot.invalid_input', 'a session acts on its own desk only: leave out desk');
        const result = await hub.machineCommand(device.id, principalFor(req, subject), subject, {
            id: req.body.id, kind, value: { ...value, desk: lease.desk }, ms: req.body.ms,
        });
        res.json({ machine_id: device.id, desk: lease.desk, ...result });
    }));

    r.delete('/machines/:id/desk-leases/:desk', limit, wrap(async (req, res) => {
        const subject = runFor(req);
        const { device, lease } = await leaseFor(req, subject);
        let stopped = false;
        try {
            const result = await hub.machineCommand(device.id, principalFor(req, subject), subject, { kind: 'desk', value: { action: 'stop', desk: lease.desk }, ms: 20000 });
            stopped = !!(result && result.result === 'ack');
        } catch { /* an offline machine stops its desks when it comes back without the lease (the plugin's idle stop) */ }
        await domain.deskLeases.remove(device.id, lease.desk);
        res.json({ machine_id: device.id, desk: lease.desk, ended: true, stopped });
    }));

    return r;
}

module.exports = { router, CAPABILITY, refusalStatus };
