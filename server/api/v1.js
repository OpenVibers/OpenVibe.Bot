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
 * | GET    /robots                                 | bot.robot.read         | own robots (or ?owner=usr_… if the owner) |
 * | POST   /robots                                 | bot.robot.manage       | the owner (new robot + pairing code)|
 * | GET    /robots/:id                             | bot.robot.read         | a member (owner/operator/viewer)    |
 * | PATCH  /robots/:id                             | bot.robot.manage       | owner                               |
 * | DELETE /robots/:id                             | bot.robot.manage       | owner                               |
 * | POST   /robots/:id/pairing-code                | bot.robot.manage       | owner                               |
 * | GET|POST /robots/:id/operators                 | bot.robot.read/manage  | owner (write) / member (read)       |
 * | DELETE /robots/:id/operators/:subject          | bot.robot.manage       | owner                               |
 * | GET    /robots/:id/devices                     | bot.robot.read         | a member                            |
 * | POST   /devices/:id/rotate, /revoke            | bot.device.connect     | the robot's owner                   |
 * | POST   /robots/:id/estop                        | bot.robot.control      | owner or operator                   |
 * | POST   /robots/:id/estop/clear                  | bot.robot.control      | the owner only                      |
 * | GET    /robots/:id/audit                        | bot.robot.read         | owner (paged)                       |
 * | POST   /pair                                    | — (one-time code)      | the agent (code is the credential)  |
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { fail, userSubject, isRobotId, json } = require('../util');
const { getProfile, listProfiles } = require('../profiles');

const CAP = {
    read: 'bot.robot.read',
    manage: 'bot.robot.manage',
    control: 'bot.robot.control',
    connect: 'bot.device.connect',
};

function v1Router({ domain, apiAuth, limits, hub }) {
    const r = express.Router();
    r.use(limits.reads('bot.read'));
    const manage = limits('bot.robot.manage', { minute: 30, hour: 300 });
    const control = limits('bot.control', { minute: 120, hour: 1200 });
    const pair = limits('bot.pair', { minute: 20, hour: 200 });

    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    const me = (req) => (req.principal.kind === 'user' ? req.principal.subject : null);
    /** The subject a call acts for: a person's own subject, or a service's X-OV-Subject / body.owner. */
    const actedFor = (req, extra) => {
        if (req.principal.kind === 'user') return req.principal.subject;
        const s = req.principal.subject || extra || req.headers['x-ov-subject'] || req.body?.owner;
        if (!s) fail(422, 'bot.invalid_input', 'a service must act for a subject (X-OV-Subject or owner)');
        return userSubject(s, 'subject');
    };
    const requireManage = (req, extra) => { if (req.principal.kind === 'service' && !apiAuth.granted(req.principal, CAP.manage)) fail(403, 'capability.denied', `${CAP.manage} not granted`); return actedFor(req, extra); };
    const requireRead = (req) => { if (req.principal.kind === 'service' && !apiAuth.granted(req.principal, CAP.read)) fail(403, 'capability.denied', `${CAP.read} not granted`); };
    const requireControlCap = (req) => { if (req.principal.kind === 'service' && !apiAuth.granted(req.principal, CAP.control)) fail(403, 'capability.denied', `${CAP.control} not granted`); };

    async function member(req, robotId, roles = ['owner', 'operator', 'viewer']) {
        const robot = await domain.robots.get(robotId);
        if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
        if (req.principal.kind === 'service') { requireRead(req); return { robot, role: 'service' }; }
        const subject = me(req);
        const role = subject ? await domain.members.roleOf(robotId, subject) : null;
        if (!role || !roles.includes(role)) fail(403, 'bot.forbidden', 'you have no access to this robot');
        return { robot, role };
    }
    async function owner(req, robotId) {
        const robot = await domain.robots.get(robotId);
        if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
        if (req.principal.kind === 'service') { requireManage(req); return robot; }
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
        const ownerSubject = req.principal.kind === 'service' ? null : me(req);
        if (req.principal.kind === 'service') requireRead(req);
        const target = ownerSubject || (req.query.owner ? userSubject(req.query.owner, 'owner') : null);
        if (!target) fail(422, 'bot.invalid_input', 'owner is required');
        res.json({ robots: (await domain.robots.list(target)).map(domain.present.robot) });
    }));
    r.post('/robots', manage, wrap(async (req, res) => {
        const ownerSubject = requireManage(req, req.body?.owner);
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
        if (req.body?.limits !== undefined) await hub.refreshConfig(req.params.id);   // the device enforces the new limits at once
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
        const d = await domain.devices.get(req.params.id);
        if (!d) fail(404, 'bot.device_not_found', 'no such device');
        await owner(req, json(d.robot_ids, [])[0]);
        const rotated = await domain.devices.rotate(req.params.id);
        res.json({ device: domain.present.device(rotated.device), credential: rotated.credential, publish_key: rotated.publish_key, whip_url: rotated.whip_url });
    }));
    r.post('/devices/:id/revoke', manage, wrap(async (req, res) => {
        const d = await domain.devices.get(req.params.id);
        if (!d) fail(404, 'bot.device_not_found', 'no such device');
        await owner(req, json(d.robot_ids, [])[0]);
        const revoked = await domain.devices.revoke(req.params.id);
        hub.closeDevice(req.params.id, 'revoked');   // revocation disconnects the device at once
        res.json({ device: domain.present.device(revoked) });
    }));

    // ── E-stop ────────────────────────────────────────────────────────────────────────────────────
    r.post('/robots/:id/estop', control, wrap(async (req, res) => {
        const { robot } = await member(req, req.params.id, ['owner', 'operator']);
        if (req.principal.kind === 'service') requireControlCap(req);
        if (!robot.estop_latched) await domain.estop.set(req.params.id, { latched: true, by: me(req) || req.principal.sub, principalKind: req.principal.kind });
        hub.sendToRobotDevices(req.params.id, { type: 'estop', latched: true, by: me(req) || req.principal.sub, at: new Date().toISOString() });
        hub.broadcast(req.params.id);
        res.json({ robot: domain.present.robot(await domain.robots.get(req.params.id)) });
    }));
    r.post('/robots/:id/estop/clear', control, wrap(async (req, res) => {
        const robot = await owner(req, req.params.id);
        await domain.estop.clear(req.params.id, robot.owner_subject);
        hub.sendToRobotDevices(req.params.id, { type: 'estop', latched: false, by: robot.owner_subject, at: new Date().toISOString() });
        hub.broadcast(req.params.id);
        res.json({ robot: domain.present.robot(await domain.robots.get(req.params.id)) });
    }));

    // ── Audit ─────────────────────────────────────────────────────────────────────────────────────
    r.get('/robots/:id/audit', wrap(async (req, res) => {
        await owner(req, req.params.id);
        let before = null;
        if (req.query.before != null && req.query.before !== '') {
            before = Number(req.query.before);
            if (!Number.isInteger(before) || before <= 0) fail(422, 'bot.invalid_input', 'before must be an audit id');
        }
        const rows = await domain.audit.listPage(req.params.id, { before, limit: Number(req.query.limit) || 50 });
        res.json({ audit: rows.map(auditPresent), next_before: rows.length ? rows[rows.length - 1].id : null });
    }));

    // ── Pairing without a prior socket (the agent may POST instead of using the WS) ───────────────
    r.post('/pair', pair, wrap(async (req, res) => {
        const result = await domain.pairing.redeem({
            robot: req.body?.robot || null, code: req.body?.code, agent_version: req.body?.agent_version || null,
            device_kind: req.body?.device_kind || 'onboard', drivers: Array.isArray(req.body?.drivers) ? req.body.drivers : [],
            capabilities: req.body?.capabilities && typeof req.body.capabilities === 'object' ? req.body.capabilities : {}, name: req.body?.name || null,
        });
        res.status(201).json({ device_id: result.device.id, credential: result.credential, publish_key: result.publish_key, whip_url: result.whip_url, robot_id: json(result.device.robot_ids, [])[0], profile: result.profile });
    }));

    return r;
}

function auditPresent(a) {
    return { id: a.id, robot_id: a.robot_id, device_id: a.device_id, operator_subject: a.operator_subject, operator_kind: a.operator_kind, role: a.role, kind: a.kind, value: a.value, result: a.result, reason: a.reason, latency_ms: a.latency_ms, at: a.at };
}

module.exports = { v1Router, CAP };
