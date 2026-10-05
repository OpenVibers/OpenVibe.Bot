'use strict';

/**
 * /api/v1 — Bot's API for services (capability-guarded Network service tokens, audience openvibe.bot)
 * and for people (their Network user token as a Bearer). Every POST needs an Idempotency-Key except
 * pairing (a one-time code is its own idempotency). Errors are RFC 9457 problem+json; the owner manages
 * robots, operators and devices, and reads the audit.
 *
 * | Method & path                                  | Capability (services)  | People                              |
 * |------------------------------------------------|------------------------|-------------------------------------|
 * | GET    /profiles, /profiles/:id                | — (public)             | anyone                              |
 * | GET    /robots                                 | bot.robot.read         | own robots (?owner= only themself)  |
 * | POST   /robots                                 | bot.robot.manage       | the owner (new robot + pairing code)|
 * | GET    /robots/:id                             | bot.robot.read         | a member (owner/operator/viewer)    |
 * | PATCH  /robots/:id                             | bot.robot.manage       | owner                               |
 * | DELETE /robots/:id                             | bot.robot.manage       | owner                               |
 * | POST   /robots/:id/pairing-code                | bot.robot.manage       | owner                               |
 * | GET|POST /robots/:id/operators                 | bot.robot.read/manage  | owner (write) / member (read)       |
 * | DELETE /robots/:id/operators/:subject          | bot.robot.manage       | owner                               |
 * | GET    /robots/:id/devices                     | bot.robot.read         | a member                            |
 * | POST   /devices/:id/rotate, /revoke            | bot.device.connect     | the robot's owner                   |
 * | POST   /devices/bind                            | — (a node token)       | a machine paired for Bot on Network |
 * | POST   /robots/:id/estop                        | bot.robot.control      | owner or operator                   |
 * | POST   /robots/:id/estop/clear                  | bot.robot.control      | the owner only                      |
 * | GET    /robots/:id/audit                        | bot.robot.read         | owner (paged)                       |
 * | POST   /jobs, /jobs/:id/cancel, GET /jobs/:id   | bot.job.dispatch       | — (services only)                   |
 * | POST   /pair                                    | — (one-time code)      | the agent (code is the credential)  |
 *
 * With BOT_PAIRING_AUTHORITY=network the pairing codes are Network's and POST /pair answers 410 bot.pairing_moved.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { fail, userSubject, isRobotId, json } = require('../util');
const { getProfile, listProfiles } = require('../profiles');
const { dispatch, cancel } = require('../jobs/dispatch');
const { get: getJob } = require('../jobs/store');

const CAP = {
    read: 'bot.robot.read',
    manage: 'bot.robot.manage',
    control: 'bot.robot.control',
    connect: 'bot.device.connect',
    dispatch: 'bot.job.dispatch',
};

function v1Router({ domain, apiAuth, limits, hub }) {
    const r = express.Router();
    r.use(limits.reads('bot.read'));
    const manage = limits('bot.robot.manage', { minute: 30, hour: 300 });
    const control = limits('bot.control', { minute: 120, hour: 1200 });
    const pair = limits('bot.pair', { minute: 20, hour: 200 });
    const jobs = limits('bot.jobs', { minute: 120, hour: 1200 });

    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    const me = (req) => (req.principal.kind === 'user' ? req.principal.subject : null);
    /** Only a person or a service acts for an owner: no token → 401, any other kind (a node token) → 403. */
    const fence = (req) => {
        if (req.principal.kind === 'anonymous') fail(401, 'bot.sign_in', 'sign in to do that');
        if (req.principal.kind !== 'user' && req.principal.kind !== 'service') fail(403, 'bot.forbidden', 'this token may not act for an owner');
    };
    /** A person acts only as themself: naming anyone else (owner / X-OV-Subject) is refused, never ignored. */
    const self = (req, ...named) => {
        const subject = req.principal.subject;
        if (named.some((s) => s != null && s !== '' && s !== subject)) fail(403, 'bot.forbidden', 'you may only act for yourself');
        return subject;
    };
    /** The subject a call acts for: a person's own subject, or a service's X-OV-Subject / body.owner. */
    const actedFor = (req, extra) => {
        fence(req);
        if (req.principal.kind === 'user') return self(req, extra, req.headers['x-ov-subject'], req.body?.owner);
        const s = extra || req.headers['x-ov-subject'] || req.body?.owner;
        if (!s) fail(422, 'bot.invalid_input', 'a service must act for a subject (X-OV-Subject or owner)');
        return userSubject(s, 'subject');
    };
    const requireManage = (req, extra) => { if (req.principal.kind === 'service' && !apiAuth.granted(req.principal, CAP.manage)) fail(403, 'capability.denied', `${CAP.manage} not granted`); return actedFor(req, extra); };
    const requireRead = (req) => { fence(req); if (req.principal.kind === 'service' && !apiAuth.granted(req.principal, CAP.read)) fail(403, 'capability.denied', `${CAP.read} not granted`); };
    const requireControlCap = (req) => { if (req.principal.kind === 'service' && !apiAuth.granted(req.principal, CAP.control)) fail(403, 'capability.denied', `${CAP.control} not granted`); };
    /** Run → Bot job dispatch is a service-to-service call: only a service token holding bot.job.dispatch. */
    const requireJobDispatch = (req) => {
        if (req.principal.kind === 'anonymous') fail(401, 'bot.sign_in', 'sign in to do that');
        if (req.principal.kind !== 'service') fail(403, 'bot.forbidden', 'job dispatch is a service-to-service call');
        if (!apiAuth.granted(req.principal, CAP.dispatch)) fail(403, 'capability.denied', `${CAP.dispatch} not granted`);
    };

    // Both fence before the lookup: without a token (or with a node token) a real robot id and a made-up one
    // get the same answer.
    async function member(req, robotId, roles = ['owner', 'operator', 'viewer']) {
        fence(req);
        const robot = await domain.robots.get(robotId);
        if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
        if (req.principal.kind === 'service') { requireRead(req); return { robot, role: 'service' }; }
        const subject = me(req);
        const role = subject ? await domain.members.roleOf(robotId, subject) : null;
        if (!role || !roles.includes(role)) fail(403, 'bot.forbidden', 'you have no access to this robot');
        return { robot, role };
    }
    async function owner(req, robotId) {
        fence(req);
        const robot = await domain.robots.get(robotId);
        if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
        if (req.principal.kind === 'service') { requireManage(req); return robot; }
        if (robot.owner_subject !== me(req)) fail(403, 'bot.forbidden', 'only the owner may do that');
        return robot;
    }
    /** The audit is a read: the owner for a person, a service with bot.robot.read (no subject needed). */
    async function ownerOrRead(req, robotId) {
        fence(req);
        const robot = await domain.robots.get(robotId);
        if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
        if (req.principal.kind === 'service') { requireRead(req); return robot; }
        if (robot.owner_subject !== me(req)) fail(403, 'bot.forbidden', 'only the owner may do that');
        return robot;
    }

    // ── Profiles (public read) ────────────────────────────────────────────────────────────────────
    r.get('/profiles', wrap(async (req, res) => {
        const rows = await listProfiles(domain.db);
        res.json({ profiles: rows.map((p) => p.profile) });
    }));
    r.get('/profiles/:id', wrap(async (req, res) => {
        const p = await getProfile(domain.db, req.params.id);
        if (!p) fail(404, 'bot.profile_not_found', 'no such profile');
        res.json({ profile: p.profile });
    }));

    // ── Robots ────────────────────────────────────────────────────────────────────────────────────
    r.get('/robots', wrap(async (req, res) => {
        requireRead(req);
        const target = req.principal.kind === 'user' ? self(req, req.query.owner, req.headers['x-ov-subject'])
            : (req.query.owner ? userSubject(req.query.owner, 'owner') : null);
        if (!target) fail(422, 'bot.invalid_input', 'owner is required');
        res.json({ robots: (await domain.robots.list(target)).map(domain.present.robot) });
    }));
    r.post('/robots', manage, wrap(async (req, res) => {
        const ownerSubject = requireManage(req, req.body?.owner);
        // ?owner= is refused, never ignored: as on GET /robots it may name only the subject the call acts for.
        if (req.query.owner != null && req.query.owner !== '' && req.query.owner !== ownerSubject) fail(403, 'bot.forbidden', 'you may only act for yourself');
        const { robot, pairing } = await domain.robots.create({
            owner: ownerSubject, name: req.body?.name, profile_id: req.body?.profile_id,
            access_policy: req.body?.access_policy, limits: req.body?.limits || {},
        });
        res.status(201).json({ robot: domain.present.robot(robot), pairing });
    }));
    r.get('/robots/:id', wrap(async (req, res) => {
        const { robot, role } = await member(req, req.params.id);
        res.json({ robot: domain.present.robot(robot), role });
    }));
    r.patch('/robots/:id', manage, wrap(async (req, res) => {
        await owner(req, req.params.id);
        const updated = await domain.robots.update(req.params.id, { name: req.body?.name, access_policy: req.body?.access_policy, limits: req.body?.limits });
        if (req.body?.limits !== undefined) await hub.refreshConfig(req.params.id);   // the device enforces the new limits and allowlist at once
        res.json({ robot: domain.present.robot(updated) });
    }));
    r.delete('/robots/:id', manage, wrap(async (req, res) => {
        await owner(req, req.params.id);
        await domain.robots.remove(req.params.id);
        res.status(204).end();
    }));
    r.post('/robots/:id/pairing-code', manage, wrap(async (req, res) => {
        await owner(req, req.params.id);
        res.status(201).json(await domain.pairing.create(req.params.id, me(req)));
    }));

    // ── Operators ─────────────────────────────────────────────────────────────────────────────────
    r.get('/robots/:id/operators', wrap(async (req, res) => {
        await member(req, req.params.id, ['owner', 'operator']);
        res.json({ operators: await domain.members.list(req.params.id) });
    }));
    r.post('/robots/:id/operators', manage, wrap(async (req, res) => {
        await owner(req, req.params.id);
        const subject = userSubject(req.body?.subject, 'subject');
        if (subject === (await domain.robots.get(req.params.id)).owner_subject) fail(422, 'bot.invalid_input', 'the owner already owns this robot');
        await domain.members.add(req.params.id, subject, req.body?.role || 'operator', me(req));
        res.status(201).json({ operators: await domain.members.list(req.params.id) });
    }));
    r.delete('/robots/:id/operators/:subject', manage, wrap(async (req, res) => {
        await owner(req, req.params.id);
        await domain.members.remove(req.params.id, userSubject(req.params.subject, 'subject'));
        res.json({ operators: await domain.members.list(req.params.id) });
    }));

    // ── Devices ───────────────────────────────────────────────────────────────────────────────────
    r.get('/robots/:id/devices', wrap(async (req, res) => {
        await member(req, req.params.id);
        const rows = await domain.devices.listForRobot(req.params.id);
        res.json({ devices: rows.map((d) => ({ ...domain.present.device(d), online: hub.isOnline(d.id) })) });
    }));
    r.post('/devices/:id/rotate', manage, wrap(async (req, res) => {
        fence(req);
        const d = await domain.devices.get(req.params.id);
        if (!d) fail(404, 'bot.device_not_found', 'no such device');
        await owner(req, json(d.robot_ids, [])[0]);
        if (d.node_principal) {
            // A Network-paired machine rotates its credential with Network itself; Bot only asks it to.
            if (d.revoked_at) fail(404, 'bot.device_not_found', 'no live device');
            const sent = hub.sendToDevice(d.id, { type: 'rotate' });
            return res.json({ device: domain.present.device(d), sent });
        }
        const rotated = await domain.devices.rotate(req.params.id);
        res.json({ device: domain.present.device(rotated.device), credential: rotated.credential, ...domain.present.video(rotated) });
    }));
    r.post('/devices/:id/revoke', manage, wrap(async (req, res) => {
        fence(req);
        const d = await domain.devices.get(req.params.id);
        if (!d) fail(404, 'bot.device_not_found', 'no such device');
        await owner(req, json(d.robot_ids, [])[0]);
        const revoked = await domain.devices.revoke(req.params.id);
        // A Network-paired machine is revoked on Network too (Bot never binds that principal again either way),
        // and the publish key it holds on OpenRe is revoked with its live session ended.
        let networkError = null;
        if (d.node_principal) await domain.devices.revokeNode(d.node_principal).catch((e) => { networkError = e; });
        await domain.devices.revokeVideo(req.params.id).catch((e) => { networkError = networkError || e; });
        hub.closeDevice(req.params.id, 'revoked');   // revocation disconnects the device at once
        if (networkError) throw networkError;          // revoked here; the owner retries for Network or OpenRe
        res.json({ device: domain.present.device(revoked) });
    }));

    // ── E-stop ────────────────────────────────────────────────────────────────────────────────────
    r.post('/robots/:id/estop', control, wrap(async (req, res) => {
        const { robot } = await member(req, req.params.id, ['owner', 'operator']);
        if (req.principal.kind === 'service') requireControlCap(req);
        if (!robot.estop_latched) await domain.estop.set(req.params.id, { latched: true, by: me(req) || req.principal.sub, principalKind: req.principal.kind });
        await hub.pushEstop(req.params.id, true, me(req) || req.principal.sub);
        hub.broadcast(req.params.id);
        res.json({ robot: domain.present.robot(await domain.robots.get(req.params.id)) });
    }));
    r.post('/robots/:id/estop/clear', control, wrap(async (req, res) => {
        const robot = await owner(req, req.params.id);
        await domain.estop.clear(req.params.id, robot.owner_subject);
        await hub.pushEstop(req.params.id, false, robot.owner_subject);
        hub.broadcast(req.params.id);
        res.json({ robot: domain.present.robot(await domain.robots.get(req.params.id)) });
    }));

    // ── Audit ─────────────────────────────────────────────────────────────────────────────────────
    r.get('/robots/:id/audit', wrap(async (req, res) => {
        await ownerOrRead(req, req.params.id);
        let before = null;
        if (req.query.before != null && req.query.before !== '') {
            before = Number(req.query.before);
            if (!Number.isInteger(before) || before <= 0) fail(422, 'bot.invalid_input', 'before must be an audit id');
        }
        const rows = await domain.audit.listPage(req.params.id, { before, limit: Number(req.query.limit) || 50 });
        res.json({ audit: rows.map(auditPresent), next_before: rows.length ? rows[rows.length - 1].id : null });
    }));

    // ── Jobs (Run → Bot: hand a platform.job@1 to a paired Node, server/jobs/dispatch.js) ─────────
    // Internal and service-to-service only: OpenVibe.Run's Network service token, never a person's.
    r.post('/jobs', jobs, wrap(async (req, res) => {
        requireJobDispatch(req);
        const project = req.body?.project_id;
        if (project == null || project === '') fail(422, 'bot.invalid_input', 'project_id is required (Run is the payer)');
        const { job, sent } = await dispatch(domain.db, req.body?.node_id, req.body?.job, {
            link: hub, project, subject: req.body?.subject ?? null, provider: req.body?.provider ?? null,
        });
        res.status(201).json({ job: presentJob(job), sent });
    }));
    r.post('/jobs/:id/cancel', jobs, wrap(async (req, res) => {
        requireJobDispatch(req);
        const { job, sent } = await cancel(domain.db, req.params.id, { link: hub });
        res.json({ job: presentJob(job), sent });
    }));
    r.get('/jobs/:id', wrap(async (req, res) => {
        requireJobDispatch(req);
        const row = await getJob(domain.db, req.params.id);
        if (!row) fail(404, 'bot.job_not_found', 'no such job');
        res.json({ job: presentJob(row), stdout: hub.jobStdout(row.id) });
    }));

    // ── Pairing without a prior socket (the agent may POST instead of using the WS) ───────────────
    r.post('/pair', pair, wrap(async (req, res) => {
        const result = await domain.pairing.redeem({
            robot: req.body?.robot || null, code: req.body?.code, agent_version: req.body?.agent_version || null,
            device_kind: req.body?.device_kind || 'onboard', drivers: Array.isArray(req.body?.drivers) ? req.body.drivers : [],
            capabilities: req.body?.capabilities && typeof req.body.capabilities === 'object' ? req.body.capabilities : {}, name: req.body?.name || null,
        });
        res.status(201).json({ device_id: result.device.id, credential: result.credential, ...domain.present.video(result), robot_id: json(result.device.robot_ids, [])[0], profile: result.profile });
    }));

    // ── Bootstrap of a Network-paired machine (its node token, once after pairing) ────────────────
    // Binds the machine to its robot and issues its WHIP publish key; calling again re-issues the key (the
    // old one stops working) for the same device. POST /pair's answer without a credential.
    r.post('/devices/bind', pair, wrap(async (req, res) => {
        if (req.principal.kind !== 'node') fail(401, 'bot.node_token_required', 'a Network node token (audience openvibe.bot) is required');
        const device = await domain.devices.bindNode(req.principal.principal);
        const issued = await domain.devices.issuePublishKey(device.id);
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json({ device_id: issued.device.id, ...domain.present.video(issued), robot_id: json(issued.device.robot_ids, [])[0], profile: issued.profile });
    }));

    return r;
}

/** The job as the dispatch API answers it: the run_jobs row (server/jobs/store.js) plus its original platform.job@1. */
function presentJob(row) {
    return {
        id: row.id, node_id: row.node_id, class: row.class, state: row.state,
        project_id: row.project_id, subject: row.subject, provider: row.provider,
        cancel_requested: row.cancel_requested, fault_code: row.fault_code,
        sent_at: row.sent_at, started_ms: row.started_ms, finished_at: row.finished_at,
        exit_reason: row.exit_reason, exit_code: row.exit_code, wall_ms: row.wall_ms,
        usage_read: row.usage_read, result: json(row.result, null), job: json(row.job, null),
        created_at: row.created_at, updated_at: row.updated_at,
    };
}

function auditPresent(a) {
    return { id: a.id, robot_id: a.robot_id, device_id: a.device_id, operator_subject: a.operator_subject, operator_kind: a.operator_kind, role: a.role, kind: a.kind, value: a.value, result: a.result, reason: a.reason, latency_ms: a.latency_ms, at: a.at };
}

module.exports = { v1Router, CAP };
