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
 * | POST   /profiles/validate                      | — (public)             | anyone (the profile validator)      |
 * | GET    /kits, /kits/:id                        | — (public)             | anyone                              |
 * | GET    /resources, /resources/:ovrn            | bot.resource.read      | — (services only, loopback)         |
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
 * | POST   /robots/:id/commands                     | bot.robot.control      | owner or operator                   |
 * | GET    /robots/:id/audit                        | bot.robot.read         | owner (paged)                       |
 * | GET    /robots/:id/streaming                    | bot.robot.read         | a member                            |
 * | POST   /robots/:id/streaming                    | bot.robot.manage       | the owner                           |
 * | POST   /jobs, /jobs/:id/cancel, GET /jobs/:id   | bot.job.dispatch       | — (services only)                   |
 * | POST   /pair                                    | — (one-time code)      | the agent (code is the credential)  |
 * | POST   /claims                                  | — (anyone)             | a device asking to be added: a code |
 * | GET    /claims/:id                              | — (X-OV-Claim-Secret)  | that device: pending, or its pairing|
 *
 * With BOT_PAIRING_AUTHORITY=network the pairing codes are Network's and POST /pair answers 410 bot.pairing_moved.
 */
const { validCallWord, DEFAULT_CALL_WORD } = require('../voice');
const express = require('express');
const { parseSteps, stepHelp, AGENT_MAX_STEPS, AGENT_MAX_S } = require('../routines');
const { http } = require('openvibe-contracts');
const { fail, userSubject, isRobotId, json } = require('../util');
const { createMachineScreen } = require('../machine-screen');
const { getProfile, listProfiles, checkProfile } = require('../profiles');
const kits = require('../kits');
const resourceIndex = require('./resource-index');
const resourceControl = require('./resource-control');

const CAP = {
    read: 'bot.robot.read',
    manage: 'bot.robot.manage',
    control: 'bot.robot.control',
    connect: 'bot.device.connect',
    dispatch: 'bot.job.dispatch',
    computer: 'bot.computer.control',
};

/** Services that act as a person's agent (plan T15/T17): they drive a robot only where its owner turned agent_control on. */
const AGENT_SERVICES = new Set(['svc:actor']);
/**
 * Services that use a person's machine, each only for the kinds it is allowed and only where the owner turned on its
 * switch on openvibe.bot/machines: the agent (any computer kind) and Watch's node source (read-only probes).
 */
const MACHINE_SERVICES = {
    'svc:actor': { kinds: null, flag: 'agent_computer', off: 'the owner has not let their agent use this computer' },
    'svc:watch': { kinds: new Set(['probe']), flag: 'watch_probe', off: 'the owner has not let their watches check things from this computer' },
};

function v1Router({ domain, apiAuth, limits, hub, jobs: jobService, config, submissions = null, routines = null, webhooks = null, claims = null }) {
    const r = express.Router();
    r.use(limits.reads('bot.read'));
    // Control first (bot.resource.control), then the index (bot.resource.read) for everything else under /resources.
    r.use('/resources/control', limits('bot.control', { minute: 120, hour: 1200 }), resourceControl.router({ domain, apiAuth, hub }));
    r.use('/resources', resourceIndex.router({ db: domain.db, apiAuth }));
    const manage = limits('bot.robot.manage', { minute: 30, hour: 300 });
    const control = limits('bot.control', { minute: 120, hour: 1200 });
    const machineScreen = createMachineScreen({ domain, hub });
    // The command route counts against the acted-for person, not the service token: a bound channel's chat
    // forwards many viewers' commands through one service, and each viewer gets their own bucket. A service
    // is also capped by its own token (bot.control.service, 10× the per-person bucket): the subject is only
    // shape-checked here, so a service naming a fresh well-formed viewer on every request would otherwise
    // never reach a ceiling.
    const commandControl = limits.actedFor('bot.control', { minute: 120, hour: 1200 },
        { minute: config.actorLimits.controlServiceMinute, hour: config.actorLimits.controlServiceHour });
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
    // Bot's public key for community profiles' signatures (server/submissions.js): Ed25519 over the canonical JSON.
    r.get('/profiles/signing-key', wrap(async (req, res) => {
        const key = submissions && submissions.signingKey();
        if (!key) fail(404, 'bot.signing_unavailable', 'no profile signing key is configured');
        res.json({ key });
    }));
    // A community profile also carries the signature its approval made, and where its driver and guide are.
    r.get('/profiles/:id', wrap(async (req, res) => {
        const p = await getProfile(domain.db, req.params.id);
        if (!p) fail(404, 'bot.profile_not_found', 'no such profile');
        const signature = submissions && p.id.startsWith('community.') ? await submissions.signatureFor(p.id, p.version) : null;
        res.json({ profile: p.profile, ...(signature ? { signature } : {}) });
    }));
    // The same validator the /docs/profiles form runs (server/profiles checkProfile): a profile in,
    // { valid, problems[] } out. Public, and rate-limited per address exactly as the form is.
    r.post('/profiles/validate', limits('bot.docs.validate', { minute: 30, hour: 300 }), wrap((req, res) => {
        const body = req.body;
        const value = body && typeof body.profile === 'object' && body.profile !== null ? body.profile : body;
        const result = checkProfile(value);
        res.json({ valid: result.valid, problems: result.problems, ...(result.profile ? { profile: result.profile } : {}) });
    }));

    // ── Kits (public read; the "Get a robot" catalogue, server/kits/*.json) ────────────────────────
    r.get('/kits', wrap(async (req, res) => {
        res.json({ kits: kits.list() });
    }));
    r.get('/kits/:id', wrap(async (req, res) => {
        const kit = kits.get(req.params.id);
        if (!kit) fail(404, 'bot.kit_not_found', 'no such kit');
        res.json({ kit });
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

    // ── Routines and webhooks (server/routines.js, server/webhooks.js): the owner's, or a service's with manage ──
    const presentRoutine = (r) => ({
        id: r.id, robot_id: r.robot_id, name: r.name, steps: r.source, trigger: typeof r.trigger === 'string' ? JSON.parse(r.trigger) : r.trigger,
        enabled: r.enabled, next_run_at: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
        last_run_at: r.last_run_at ? new Date(r.last_run_at).toISOString() : null, last_result: r.last_result || null,
    });
    const needAutomation = () => { if (!routines || !webhooks) fail(503, 'bot.unavailable', 'automation is not available'); };
    r.get('/robots/:id/routines', wrap(async (req, res) => {
        needAutomation();
        await ownerOrRead(req, req.params.id);
        res.json({ routines: (await routines.list(req.params.id)).map(presentRoutine) });
    }));
    r.post('/robots/:id/routines', manage, wrap(async (req, res) => {
        needAutomation();
        const robot = await owner(req, req.params.id);
        const profile = await getProfile(domain.db, robot.profile_id, robot.profile_version);
        const b = req.body || {};
        const made = await routines.create(robot, { subject: req.principal.kind === 'service' ? actedFor(req) : me(req) },
            { name: b.name, source: b.steps, trigger: b.trigger || { type: 'manual' }, enabled: b.enabled !== false }, profile && profile.profile);
        res.status(201).json({ routine: presentRoutine(made) });
    }));
    r.post('/robots/:id/routines/:rid/run', manage, wrap(async (req, res) => {
        needAutomation();
        const robot = await owner(req, req.params.id);
        const routine = await routines.get(req.params.rid);
        if (!routine || routine.robot_id !== robot.id) fail(404, 'bot.routine_not_found', 'no such routine');
        if (!await routines.run(routine.id, { reason: 'api' })) fail(409, 'bot.routine_busy', 'a routine is already running on this robot');
        res.status(202).json({ routine: presentRoutine(await routines.get(routine.id)) });
    }));
    r.delete('/robots/:id/routines/:rid', manage, wrap(async (req, res) => {
        needAutomation();
        const robot = await owner(req, req.params.id);
        if (!await routines.remove(robot.id, req.params.rid)) fail(404, 'bot.routine_not_found', 'no such routine');
        res.status(204).end();
    }));
    r.get('/robots/:id/webhooks', wrap(async (req, res) => {
        needAutomation();
        await ownerOrRead(req, req.params.id);
        res.json({ webhooks: await webhooks.list(req.params.id), events: webhooks.EVENTS });
    }));
    // The secret is in this answer only: a hook's later reads never carry it.
    r.post('/robots/:id/webhooks', manage, wrap(async (req, res) => {
        needAutomation();
        const robot = await owner(req, req.params.id);
        const made = await webhooks.create(robot, { subject: req.principal.kind === 'service' ? actedFor(req) : me(req) }, { url: req.body?.url, events: req.body?.events });
        res.status(201).json({ webhook: made.hook, secret: made.secret });
    }));
    r.delete('/robots/:id/webhooks/:hid', manage, wrap(async (req, res) => {
        needAutomation();
        const robot = await owner(req, req.params.id);
        if (!await webhooks.remove(robot.id, req.params.hid)) fail(404, 'bot.webhook_not_found', 'no such webhook');
        res.status(204).end();
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
        // and the publish key it holds on OpenRestream is revoked with its live session ended.
        let networkError = null;
        if (d.node_principal) await domain.devices.revokeNode(d.node_principal).catch((e) => { networkError = e; });
        await domain.devices.revokeVideo(req.params.id).catch((e) => { networkError = networkError || e; });
        hub.closeDevice(req.params.id, 'revoked');   // revocation disconnects the device at once
        if (networkError) throw networkError;          // revoked here; the owner retries for Network or OpenRestream
        res.json({ device: domain.present.device(revoked) });
    }));

    // ── Streaming (the owner's OpenRestream toggles, read from OpenRestream; Bot stores no copy) ───────────────
    // Reading is a member read, like GET /robots/:id. Changing is the owner's alone (`manage`, not
    // `control`): whether a robot's camera is recorded or shown on the owner's channel is their call.
    r.get('/robots/:id/streaming', wrap(async (req, res) => {
        await member(req, req.params.id);
        res.json(await domain.streaming.get(req.params.id));
    }));
    r.post('/robots/:id/streaming', manage, wrap(async (req, res) => {
        const robot = await owner(req, req.params.id);
        const subject = req.principal.kind === 'user' ? me(req) : userSubject(req.headers['x-ov-subject'] || req.body?.owner, 'subject');
        res.json(await domain.streaming.set(req.params.id, { subject, kind: req.principal.kind }, { to: req.body?.to, on: req.body?.on }));
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

    // ── Commands (the /control gate over HTTP: a service forwards a bound channel's chat commands) ─
    // The same onOperatorCommand path as the /control socket — the gate, the audit and the per-subject
    // idempotency key are shared. `id` is that idempotency key; a repeated id is answered from the cache.
    r.post('/robots/:id/commands', commandControl, wrap(async (req, res) => {
        requireControlCap(req);
        const subject = actedFor(req);
        // The owner's agent (OpenVibe.Actor) drives only a robot its owner opened to it, and only as that owner.
        if (req.principal.kind === 'service' && AGENT_SERVICES.has(req.principal.sub)) {
            const robot = await domain.robots.get(req.params.id);
            if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
            if (!robot.agent_control) fail(403, 'bot.agent_not_allowed', 'the owner has not let their agent drive this robot');
            if (subject !== robot.owner_subject) fail(403, 'bot.agent_not_allowed', 'an agent drives a robot only for its owner');
        }
        const principal = req.principal.kind === 'service' ? { ...req.principal, subject } : req.principal;
        const result = await hub.operatorCommand(req.params.id, principal, subject, {
            id: req.body?.id, kind: req.body?.kind, value: req.body?.value, ms: req.body?.ms,
        });
        if (result.result === 'refused') fail(commandRefusalStatus(result.code), result.code, result.reason || null);
        res.json({ robot_id: req.params.id, ...result });
    }));

    // ── A person's own computer (the Node's computer plugin, plan T14/T17) ─────────────────────────────
    // The machine's owner, or their agent (an agent service with bot.computer.control, acting for that owner) where the
    // owner turned "Let my agent use this computer" on. What may happen there is the owner's level on the machine.
    async function computerMachine(req, { agentNeedsOptIn = true, kind = null } = {}) {
        const subject = actedFor(req);
        const svc = req.principal.kind === 'service' ? MACHINE_SERVICES[req.principal.sub] : null;
        if (req.principal.kind === 'service') {
            if (!svc) fail(403, 'bot.forbidden', 'a machine is used by its owner, their agent and their watches only');
            if (!apiAuth.granted(req.principal, CAP.computer)) fail(403, 'capability.denied', `${CAP.computer} not granted`);
            if (kind != null && svc.kinds && !svc.kinds.has(String(kind))) fail(403, 'bot.forbidden', `${req.principal.sub} may send ${[...svc.kinds].join(', ')} only`);
        }
        const device = await domain.devices.get(String(req.params.id || '').slice(0, 64));
        const ownerSubject = device && !device.revoked_at ? await domain.devices.ownerOf(device) : null;
        if (!ownerSubject || ownerSubject !== subject) fail(404, 'bot.device_not_found', 'no such machine of yours');
        if (agentNeedsOptIn && svc && !device[svc.flag]) fail(403, 'bot.agent_not_allowed', svc.off);
        return { device, subject };
    }
    const machineOut = (device) => {
        const st = hub.deviceState(device.id);
        const offered = hub.computerOf(device.id);
        const sensors = st.telemetry && st.telemetry.sensors && typeof st.telemetry.sensors === 'object' ? st.telemetry.sensors : {};
        const pick = (cap) => (offered && offered[cap] && typeof offered[cap] === 'object' ? offered[cap] : null);
        return {
            id: device.id, name: device.name || null, online: !!st.online, agent_computer: !!device.agent_computer, watch_probe: !!device.watch_probe,
            voice: { on: !!device.voice_on, call_word: device.call_word || DEFAULT_CALL_WORD },
            computer: offered ? {
                level: typeof sensors.computer_level === 'string' ? sensors.computer_level : ((pick('files') || pick('terminal') || pick('screen') || {}).level || null),
                terminal: pick('terminal'), files: pick('files'), screen: pick('screen'), probe: pick('probe'), input: pick('input'), browser: pick('browser'), desk: pick('desk'),
                waiting: Number.isInteger(sensors.computer_waiting) ? sensors.computer_waiting : null,
            } : null,
        };
    };
    // The person's machines (theirs or their robots'); an agent sees only those whose owner let it use them.
    r.get('/machines', wrap(async (req, res) => {
        const subject = actedFor(req, req.query.owner);
        const svc = req.principal.kind === 'service' ? MACHINE_SERVICES[req.principal.sub] : null;
        if (req.principal.kind === 'service') {
            if (!svc) fail(403, 'bot.forbidden', 'machines are listed for their owner, their agent and their watches');
            if (!apiAuth.granted(req.principal, CAP.computer)) fail(403, 'capability.denied', `${CAP.computer} not granted`);
        }
        const rows = await domain.machines.list(subject);
        const mine = svc ? rows.filter((d) => d[svc.flag]) : rows;
        res.json({ machines: mine.map(machineOut) });
    }));
    r.get('/machines/:id/computer', wrap(async (req, res) => {
        const { device } = await computerMachine(req);
        res.json({ machine: machineOut(device) });
    }));
    // One exec, fs or screen command, answered with the machine's answer in `data` (bot.command-result@1). A repeated
    // id answers its first result without data; an `ask`-level machine answers once its owner approves it there.
    r.post('/machines/:id/commands', commandControl, wrap(async (req, res) => {
        const { device, subject } = await computerMachine(req, { kind: req.body?.kind });
        const principal = req.principal.kind === 'service' ? { ...req.principal, subject } : req.principal;
        const result = await hub.machineCommand(device.id, principal, subject, { id: req.body?.id, kind: req.body?.kind, value: req.body?.value, ms: req.body?.ms });
        if (result.result === 'refused') fail(commandRefusalStatus(result.code), result.code, result.reason || null);
        res.json({ machine_id: device.id, ...result });
    }));
    // The live screen (plan T14): the machine's owner, signed in as themselves, watches it on their own private stream.
    // Never an agent, a watch or another service: screen_stream is not a bot.command@1 kind, and only this route sends it.
    const screenOwner = async (req) => {
        if (req.principal.kind !== 'user') fail(403, 'bot.forbidden', 'only the machine\'s owner, signed in, shows its screen');
        return computerMachine(req, { agentNeedsOptIn: false });
    };
    r.post('/machines/:id/screen', manage, wrap(async (req, res) => {
        const { device, subject } = await screenOwner(req);
        const out = await machineScreen.start(device, subject, req.principal, { seconds: req.body?.seconds, fps: req.body?.fps, desk: req.body?.desk });
        res.status(201).json({ machine_id: device.id, ...out });
    }));
    r.get('/machines/:id/screen', wrap(async (req, res) => {
        const { device, subject } = await screenOwner(req);
        res.set('Cache-Control', 'no-store');
        res.json({ machine_id: device.id, ...(await machineScreen.state(device, subject)) });
    }));
    r.delete('/machines/:id/screen', manage, wrap(async (req, res) => {
        const { device, subject } = await screenOwner(req);
        res.json({ machine_id: device.id, ...(await machineScreen.stop(device, subject, req.principal)) });
    }));
    // The owner lets their watches probe from the machine, or stops them (never Watch itself).
    r.post('/machines/:id/watch-probe', manage, wrap(async (req, res) => {
        if (req.principal.kind !== 'user') fail(403, 'bot.forbidden', 'only the machine\'s owner turns this on or off');
        const { device } = await computerMachine(req, { agentNeedsOptIn: false });
        if (typeof req.body?.on !== 'boolean') fail(422, 'bot.invalid_input', 'on is true or false');
        const updated = await domain.machines.setWatchProbe(device.id, req.body.on);
        res.json({ machine: machineOut(updated) });
    }));
    // The owner lets Vibe answer their voice on the machine, with a call word, or stops it (never an agent or a service).
    r.post('/machines/:id/voice', manage, wrap(async (req, res) => {
        if (req.principal.kind !== 'user') fail(403, 'bot.forbidden', 'only the machine\'s owner turns this on or off');
        const { device } = await computerMachine(req, { agentNeedsOptIn: false });
        if (typeof req.body?.on !== 'boolean') fail(422, 'bot.invalid_input', 'on is true or false');
        const word = req.body.call_word == null ? null : validCallWord(req.body.call_word);
        if (req.body.call_word != null && !word) fail(422, 'bot.invalid_input', 'a call word is 1 to 4 words, 3 to 40 characters, with one word of three letters or more');
        const updated = await domain.machines.setVoice(device.id, req.body.on, word);
        if (hub && hub.machineChanged) await hub.machineChanged(updated);
        res.json({ machine: machineOut(updated) });
    }));
    // The owner turns their agent's use of the machine on or off (never the agent itself).
    r.post('/machines/:id/agent-computer', manage, wrap(async (req, res) => {
        if (req.principal.kind !== 'user') fail(403, 'bot.forbidden', 'only the machine\'s owner turns this on or off');
        const { device } = await computerMachine(req, { agentNeedsOptIn: false });
        if (typeof req.body?.on !== 'boolean') fail(422, 'bot.invalid_input', 'on is true or false');
        const updated = await domain.machines.setAgentComputer(device.id, req.body.on);
        res.json({ machine: machineOut(updated) });
    }));

    // ── Steps (the owner's agent): plain step lines, run now as the owner and answered when they end ──
    // The owner themself, or an agent service (OpenVibe.Actor) acting for the owner of a robot with agent_control on.
    // Every step passes the same gate as a person's command (server/routines.js runSteps).
    async function agentRobot(req) {
        const subject = req.principal.kind === 'service' ? actedFor(req) : me(req);
        const robot = await domain.robots.get(req.params.id);
        if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
        if (req.principal.kind === 'service') {
            if (!AGENT_SERVICES.has(req.principal.sub)) fail(403, 'bot.forbidden', 'steps are for the owner and their agent');
            if (!robot.agent_control) fail(403, 'bot.agent_not_allowed', 'the owner has not let their agent drive this robot');
        }
        if (subject !== robot.owner_subject) fail(403, req.principal.kind === 'service' ? 'bot.agent_not_allowed' : 'bot.forbidden', 'steps run only for the robot\'s owner');
        const profile = await getProfile(domain.db, robot.profile_id, robot.profile_version);
        if (!profile) fail(409, 'bot.profile_missing', 'the robot\'s profile is gone');
        return { robot, subject, profile: profile.profile };
    }
    r.get('/robots/:id/steps', wrap(async (req, res) => {
        needAutomation();
        requireRead(req);
        const { robot, profile } = await agentRobot(req);
        const st = await hub.robotState(robot.id);
        const sensors = st.telemetry && st.telemetry.sensors && typeof st.telemetry.sensors === 'object' ? st.telemetry.sensors : {};
        res.json({
            robot_id: robot.id, name: robot.name, profile_id: robot.profile_id, online: st.online, estop: st.estop, battery: st.battery, sensors,
            steps: stepHelp(profile), max_steps: AGENT_MAX_STEPS, max_seconds: AGENT_MAX_S,
        });
    }));
    r.post('/robots/:id/steps', commandControl, wrap(async (req, res) => {
        needAutomation();
        requireControlCap(req);
        const { robot, subject, profile } = await agentRobot(req);
        const { steps } = parseSteps(req.body?.steps, profile);
        const principal = req.principal.kind === 'service' ? { ...req.principal, subject } : req.principal;
        const result = await routines.runSteps(robot, steps, { principal, subject });
        res.json({ robot_id: robot.id, result, steps: steps.length });
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

    // ── Jobs (Run → Bot: hand a platform.job@1 to a paired Node, server/jobs/index.js) ────────────
    // Internal and service-to-service only: OpenVibe.Run's Network service token, never a person's.
    r.post('/jobs', jobs, wrap(async (req, res) => {
        requireJobDispatch(req);
        const project = req.body?.project_id;
        if (project == null || project === '') fail(422, 'bot.invalid_input', 'project_id is required (Run is the payer)');
        res.status(201).json(await jobService.dispatch(req.body?.node_id, req.body?.job, {
            project, subject: req.body?.subject ?? null, provider: req.body?.provider ?? null,
        }));
    }));
    r.post('/jobs/:id/cancel', jobs, wrap(async (req, res) => {
        requireJobDispatch(req);
        res.json(await jobService.cancel(req.params.id));
    }));
    r.get('/jobs/:id', wrap(async (req, res) => {
        requireJobDispatch(req);
        const state = await jobService.state(req.params.id);
        if (!state) fail(404, 'bot.job_not_found', 'no such job');
        res.json(state);
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

    // ── A device asking to be added (server/claims.js): the installer run with no robot and no code ─
    // Anyone may start one: it only makes a code for a signed-in person to approve on /link. Only the secret the start
    // answered reads it back (a header of its own, so it is never taken for a token). Both are counted by address.
    const claimStart = limits('bot.claim', { minute: 6, hour: 40 });
    const claimPoll = limits('bot.claim.poll', { minute: 40, hour: 1200 });
    const needClaims = () => { if (!claims) fail(503, 'bot.unavailable', 'adding a device by code is not available here'); };
    r.post('/claims', claimStart, wrap(async (req, res) => {
        needClaims();
        // setup_key: a card made on /setup/sd-card (server/setup-keys.js) approves its own claim.
        const out = await claims.start({ hostname: req.body?.hostname, hardware: req.body?.hardware, address: req.ip || null,
            setupKey: typeof req.body?.setup_key === 'string' ? req.body.setup_key : null });
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json(out);
    }));
    r.get('/claims/:id', claimPoll, wrap(async (req, res) => {
        needClaims();
        res.setHeader('Cache-Control', 'no-store');
        res.json(await claims.poll(req.params.id, String(req.headers['x-ov-claim-secret'] || '')));
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

/** The HTTP status a refused command's gate code answers with (the /control refusal codes, docs/protocol.md §2). */
function commandRefusalStatus(code) {
    if (code === 'bot.robot_not_found') return 404;
    if (code === 'bot.not_an_operator' || code === 'bot.read_only' || code === 'bot.forbidden' || code === 'bot.not_your_turn') return 403;
    if (code === 'bot.cooldown' || code === 'bot.turn_budget') return 429;
    if (code === 'bot.device_offline' || code === 'bot.estop_latched' || code === 'bot.command_pending' || code === 'bot.computer_off' || code === 'bot.person_driving') return 409;
    return 422;   // unknown_command, command_not_allowed, unknown_actuator, invalid_input, text_too_long
}

function auditPresent(a) {
    return { id: a.id, robot_id: a.robot_id, device_id: a.device_id, operator_subject: a.operator_subject, operator_kind: a.operator_kind, role: a.role, kind: a.kind, value: a.value, result: a.result, reason: a.reason, latency_ms: a.latency_ms, at: a.at };
}

module.exports = { v1Router, CAP, AGENT_SERVICES, MACHINE_SERVICES };
