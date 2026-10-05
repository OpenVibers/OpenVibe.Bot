'use strict';

/**
 * The two WebSockets (ADR-043 decisions 4, 5 and 8), one hub for both.
 *
 *   wss://…/device    one outbound connection per device. Auth by `Authorization: Bearer <credential>`
 *                     on the upgrade, never a query string; an unauthenticated socket may only send
 *                     `pair`. A Network-paired machine presents its node token instead (bound on first
 *                     use) and renews it with `reauth` before the 330 s deadline, else close 4002. Heartbeats every 1 s; offline after 2 missed + 3 s grace. Commands are
 *                     never queued for an offline device and never replayed after a reconnect. Jobs
 *                     (platform.job-frame@1, server/jobs/dispatch.js) are the exception: an unacked `job`
 *                     is resent on every reconnect, and the Node never runs one id twice.
 *   wss://…/control   a signed-in person (Network session cookie or Bearer) or a service token holding
 *                     `bot.robot.control` acting for `X-OV-Subject`. Joins a robot, sends commands; the
 *                     gate lives in the domain and every decision is audited.
 *   wss://…/watch     anyone, no credential (plan T15 R9): joins a robot whose owner turned on embed_public and
 *                     receives its public state only (robotState → publicState). Read-only: any frame but
 *                     join/leave answers bot.read_only and never reaches a device or the audit. Capped per client
 *                     address and per robot (config.watch); over a cap the socket closes 4003.
 *
 * Every frame carries v, seq, ts. A command's `id` is an idempotency key: a repeated id answers with the
 * first result instead of reaching the device again.
 */
const { WebSocketServer } = require('ws');
const { capabilities, ids } = require('openvibe-contracts');
const { json, iso, prefixedId } = require('./util');
const { userPrincipal, verifyService, verifyNode, isNodeToken, PRINCIPAL_SUB, decodePayload } = require('./api/auth');
const { getProfile } = require('./profiles');

const OPEN = 1;
const MAX_BACKLOG = 64;   // frames a device may send before its authentication completes
const ACCESS_COOKIE = 'ov_token';
const DEVICE_KINDS = new Set(['onboard', 'bridge', 'server']);
const MAX_AGENT_VERSION = 40;
const WATCH_MAX_PAYLOAD = 4 * 1024;   // a watcher only ever sends join/leave

function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}
const bearer = (req) => { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7).trim() : null; };
const isSubject = (v) => typeof v === 'string' && ids.isSubjectId('user', v);

function createRealtime({ config, keys, userAuth, log = console, now = () => Date.now() }) {
    let domain = null;
    const deviceConns = new Map();     // device_id → conn
    const subsByRobot = new Map();     // robot_id → Set<conn>
    const pendingCmds = new Map();     // device-facing command id (server-minted) → pending
    const results = new Map();         // operator key (who + their id) → { result, reason, at }
    const inflight = new Map();        // operator key → device-facing id, while the command is pending
    const timers = [];
    let closed = false;

    const deviceWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
    const controlWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
    const watchWss = new WebSocketServer({ noServer: true, maxPayload: WATCH_MAX_PAYLOAD, perMessageDeflate: false });
    const watchConns = new Set();      // every /watch socket, joined or not
    const watchersByAddr = new Map();  // client address → open /watch sockets
    const offlineAfterMs = config.device.heartbeatMs * config.device.offlineMisses + config.device.offlineGraceMs;
    let jobs = null;                   // the jobs service (server/jobs/index.js), bound by server/app.js

    const nextSeq = (conn) => ++conn.seq;
    function send(ws, obj) { if (ws.readyState === OPEN) { ws.send(JSON.stringify(obj)); return true; } return false; }
    function sendFrame(conn, type, fields) { return send(conn.ws, { v: 1, seq: nextSeq(conn), ts: now(), type, ...fields }); }
    function sendError(conn, code, detail) { return sendFrame(conn, 'error', { code, detail: detail || null }); }
    const deviceRobotIds = (device) => json(device.robot_ids, []);
    /** The job frames' view of one device socket (server/jobs/dispatch.js). */
    const jobLink = (conn) => ({ deviceId: conn.device.id, send: (type, fields) => sendFrame(conn, type, fields), error: (code, detail) => sendError(conn, code, detail) });
    /** A socket's job frames are handled one at a time in arrival order: second n is queued before n+1, job_exit last. */
    function jobFrame(conn, msg) {
        const run = (conn.jobFrames || Promise.resolve()).then(() => jobs.frames.onFrame(jobLink(conn), msg));
        conn.jobFrames = run.catch(() => {});
        return run;
    }

    // ── Upgrade routing ───────────────────────────────────────────────────────────────────────────
    function handleUpgrade(req, socket, head) {
        if (closed) return socket.destroy();
        let path;
        try { path = new URL(req.url, 'http://localhost').pathname; } catch { return socket.destroy(); }
        if (path === '/device') return deviceWss.handleUpgrade(req, socket, head, (ws) => onDeviceSocket(ws, req));
        if (path === '/control') return controlWss.handleUpgrade(req, socket, head, (ws) => onControlSocket(ws, req));
        if (path === '/watch') return watchWss.handleUpgrade(req, socket, head, (ws) => onWatchSocket(ws, req));
        socket.destroy();
    }

    /**
     * An in-process device (server/sim): no socket and no credential, so it is attached here and never through
     * /device. `device` is the device as the hub sees it ({ id, robot_ids, kind }); `onFrame(frame)` gets what Bot
     * sends it, on a later tick as a real socket would; its frames come back through `deliver`, the same path a
     * socket's frames take. A real device online for the same robot is preferred over a simulated one.
     */
    function attachSim(device, { onFrame, onClose = () => {} }) {
        if (closed) return null;
        const ws = {
            readyState: OPEN,
            send(data) { setImmediate(() => { if (ws.readyState === OPEN) onFrame(JSON.parse(data)); }); },
            close() { if (ws.readyState !== OPEN) return; ws.readyState = 3; onClose(); },
        };
        const conn = { ws, sim: true, seq: 0, pending: false, device: null, online: false, rttMs: null, telemetry: null, status: null, deviceEstop: new Map(), backlog: null, lastHeartbeat: now(), lastTelemetry: 0, sessionId: prefixedId('sess', now()) };
        attachDevice(conn, device);
        sendHello(conn);
        const ready = sendConfig(conn).then(() => bringOnline(conn)).catch((e) => log.warn(`[Bot] simulator ${device.id}: ${e.message}`));
        return { deliver: (frame) => (ws.readyState === OPEN ? onDeviceFrame(conn, JSON.stringify(frame)) : undefined), ready };
    }
    function detachSim(deviceId) {
        const c = deviceConns.get(deviceId);
        if (!c || !c.sim) return;
        c.ws.close();
        dropDevice(c);
    }

    // ── Device side ───────────────────────────────────────────────────────────────────────────────
    async function onDeviceSocket(ws, req) {
        // backlog: while authentication (credential or pair) is in progress, frames wait here and are handled
        // in order once it resolves, so a device's first status/estop_state is never lost or answered not_paired.
        // deviceEstop: robot_id → the device's own last estop_state report (a report only, never a clear).
        const conn = { ws, seq: 0, pending: true, device: null, online: false, rttMs: null, telemetry: null, status: null, deviceEstop: new Map(), backlog: null, lastHeartbeat: now(), lastTelemetry: 0, sessionId: prefixedId('sess', now()) };
        ws.conn = conn;
        ws.on('message', (raw) => onDeviceFrame(conn, raw));
        ws.on('close', () => { conn.backlog = null; dropDevice(conn); });
        ws.on('error', () => { /* the close event does the work */ });
        const cred = bearer(req);   // the query string is never read
        if (cred) {
            conn.backlog = [];
            try {
                if (isNodeToken(cred)) await authenticateNode(conn, cred);
                else await authenticateDevice(conn, cred);
                sendHello(conn);
                await sendConfig(conn);
                await bringOnline(conn);
            } catch (e) { log.warn(`[Bot] device auth: ${e.message}`); conn.backlog = null; ws.close(4002, 'invalid credential'); return; }
            await jobs.frames.onConnect(jobLink(conn)).catch((e) => log.warn(`[Bot] job resend to ${conn.device.id}: ${e.message}`));
            await drainBacklog(conn);
        }
    }

    function deviceFailed(conn, e) {
        log.warn(`[Bot] device ${conn.device ? conn.device.id : '?'}: ${e.message}`);
        sendError(conn, e.code || 'bot.internal', e.detail || e.message);
    }
    function onDeviceFrame(conn, raw) {
        if (!conn.backlog) return handleDeviceMessage(conn, raw).catch((e) => deviceFailed(conn, e));
        if (conn.backlog.length < MAX_BACKLOG) return conn.backlog.push(raw);
        return sendError(conn, 'bot.not_ready', 'too many frames before authentication completed');
    }
    /** Handles the frames that arrived during authentication, in arrival order (later ones join the queue). */
    async function drainBacklog(conn) {
        while (conn.backlog && conn.backlog.length) {
            const raw = conn.backlog.shift();
            await handleDeviceMessage(conn, raw).catch((e) => deviceFailed(conn, e));
        }
        conn.backlog = null;
    }

    async function authenticateDevice(conn, credential) {
        const device = await domain.devices.byCredential(credential);
        if (!device) throw new Error('unknown or revoked credential');
        attachDevice(conn, device);
    }

    /** A node token: verified offline, then bound to its device (created on first use from Network's record). */
    async function authenticateNode(conn, nodeToken) {
        const r = verifyNode(nodeToken, { publicKey: keys.get(), issuer: config.network.issuer, audience: config.audience });
        if (!r.ok) throw new Error(`node token refused: ${r.code}`);
        const device = await domain.devices.bindNode(r.principal);
        conn.node = { principal: r.principal, reauthBy: now() + config.device.nodeReauthMs };
        attachDevice(conn, device);
    }
    /** `reauth`: a fresh node token for the same principal moves the deadline; anything else leaves it. */
    function onReauth(conn, msg) {
        const r = verifyNode(typeof msg.token === 'string' ? msg.token : '', { publicKey: keys.get(), issuer: config.network.issuer, audience: config.audience });
        if (!r.ok) return sendError(conn, 'bot.reauth_refused', r.reason);
        if (r.principal !== conn.node.principal) return sendError(conn, 'bot.reauth_refused', 'the token is for another machine');
        conn.node.reauthBy = now() + config.device.nodeReauthMs;
        return undefined;
    }

    /**
     * `status` of a Network-paired device: device_kind, drivers, capabilities and agent_version are persisted
     * when they differ from the row. Any invalid one → bot.bad_frame and the row unchanged.
     */
    async function persistDeclared(conn, msg) {
        const d = conn.device;
        const has = (k) => msg[k] !== undefined;
        if ((has('device_kind') && !DEVICE_KINDS.has(msg.device_kind))
            || (has('drivers') && !(Array.isArray(msg.drivers) && msg.drivers.every((x) => typeof x === 'string')))
            || (has('capabilities') && !(msg.capabilities && typeof msg.capabilities === 'object' && !Array.isArray(msg.capabilities)))
            || (has('agent_version') && !(typeof msg.agent_version === 'string' && msg.agent_version.length <= MAX_AGENT_VERSION))) {
            return sendError(conn, 'bot.bad_frame', `device_kind must be one of ${[...DEVICE_KINDS].join('|')}, drivers an array of strings, capabilities an object, agent_version a string of at most ${MAX_AGENT_VERSION}`);
        }
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const change = {};
        if (has('device_kind') && msg.device_kind !== d.kind) change.kind = msg.device_kind;
        if (has('drivers') && !same(msg.drivers, json(d.drivers, []))) change.drivers = msg.drivers;
        if (has('capabilities') && !same(msg.capabilities, json(d.capabilities, {}))) change.capabilities = msg.capabilities;
        if (has('agent_version') && msg.agent_version !== (d.agent_version ?? null)) change.agent_version = msg.agent_version;
        if (!Object.keys(change).length) return undefined;
        const updated = await domain.devices.updateDeclared(d.id, change);
        if (updated) conn.device = updated;
        return undefined;
    }

    function attachDevice(conn, device) {
        const existing = deviceConns.get(device.id);
        if (existing && existing.ws !== conn.ws) { try { existing.ws.close(4000, 'replaced by a newer connection'); } catch { /* gone */ } dropDevice(existing, { silent: true }); }
        conn.pending = false; conn.device = device; conn.online = true; conn.lastHeartbeat = now();
        deviceConns.set(device.id, conn);
    }

    function sendHello(conn) {
        sendFrame(conn, 'hello', {
            session_id: conn.sessionId, device_id: conn.device.id, robot_ids: deviceRobotIds(conn.device),
            server_time: iso(now()),
        });
    }
    /** `config`: the effective limits (the owner's clamped by the profile's) and the kinds the profile takes. */
    async function sendConfig(conn) {
        const robotId = deviceRobotIds(conn.device)[0];
        const robot = robotId ? await domain.robots.get(robotId) : null;
        const profileRow = robot ? await getProfile(domain.db, robot.profile_id, robot.profile_version) : null;
        const profile = profileRow ? profileRow.profile : null;
        const limits = robot ? domain.control.deviceLimits(robot, profile) : { max_command_ms: config.control.maxCommandMs, heartbeat_ms: config.device.heartbeatMs };
        const allowed = robot ? domain.control.allowedFor(robot, 'owner', profile) : ['halt'];
        sendFrame(conn, 'config', {
            heartbeat_ms: config.device.heartbeatMs, limits, allowed_commands: allowed,
            estop_latched: robot ? !!robot.estop_latched : false,
        });
    }
    /** Re-send `config` to the robot's connected devices (the owner changed its limits or allowlist, or the latch moved). */
    async function refreshConfig(robotId) {
        for (const conn of [...deviceConns.values()]) {
            if (conn.online && deviceRobotIds(conn.device).includes(robotId)) await sendConfig(conn);
        }
    }
    /** Tell the robot's devices the latch moved: the `estop` frame acts at once, then `config` carries the new state. */
    async function pushEstop(robotId, latched, by) {
        sendToRobotDevices(robotId, { type: 'estop', latched, by, at: iso(now()) });
        await refreshConfig(robotId);
    }
    /** The online/offline event and last_seen are a real machine's: a simulator (no devices row) reports neither. */
    function reportOnline(conn, online) {
        if (conn.sim) return Promise.resolve();
        return domain.devices.setOnline(conn.device, online).catch((e) => log.warn(`[Bot] ${online ? 'online' : 'offline'} event: ${e.message}`));
    }
    async function bringOnline(conn) {
        await reportOnline(conn, true);
        for (const robotId of deviceRobotIds(conn.device)) broadcast(robotId);
    }

    function dropDevice(conn, { silent = false } = {}) {
        if (!conn || !conn.device) return;
        const current = deviceConns.get(conn.device.id);
        if (current === conn) deviceConns.delete(conn.device.id);
        if (!conn.online) return;
        conn.online = false;
        if (silent) return;
        reportOnline(conn, false);
        for (const robotId of deviceRobotIds(conn.device)) broadcast(robotId);
    }

    async function handleDeviceMessage(conn, raw) {
        let msg; try { msg = JSON.parse(String(raw)); } catch { return sendError(conn, 'bot.bad_json', 'frames must be JSON'); }
        if (!msg || typeof msg !== 'object') return sendError(conn, 'bot.bad_frame', 'a frame must be an object');
        if (conn.pending) {
            if (msg.type === 'pair') return handlePair(conn, msg);
            return sendError(conn, 'bot.not_paired', 'send pair first');
        }
        conn.lastHeartbeat = now();
        switch (msg.type) {
            case 'heartbeat': {
                if (Number.isFinite(msg.rtt_ms)) conn.rttMs = Math.round(msg.rtt_ms);
                // `echo` carries the device's `t` back for its RTT; the envelope `seq` stays Bot's own counter.
                const ack = { echo: msg.t !== undefined ? msg.t : null, server_time: iso(now()) };
                // OpenVibe.Node reads `heartbeat_ack.t` (its RTT is now - t), so echo it as `t` as well.
                if (Number.isFinite(msg.t)) ack.t = msg.t;
                return sendFrame(conn, 'heartbeat_ack', ack);
            }
            case 'telemetry': return onTelemetry(conn, msg);
            case 'status':
                conn.status = msg;
                for (const r of deviceRobotIds(conn.device)) broadcast(r);
                return conn.device.node_principal ? persistDeclared(conn, msg) : undefined;
            case 'reauth': if (conn.node) return onReauth(conn, msg); return sendError(conn, 'bot.unknown_message', `unknown type ${msg.type}`);
            case 'ack': case 'nack': return onAck(conn, msg);
            case 'estop_state': return onEstopState(conn, msg);
            // Jobs (platform.job-frame@1). Out: job, job_cancel, job_exit_ack (server/jobs/dispatch.js); in:
            case 'job_started': case 'job_stdout': case 'job_usage': case 'job_exit': return jobFrame(conn, msg);
            default: return sendError(conn, 'bot.unknown_message', `unknown type ${msg.type}`);
        }
    }

    async function handlePair(conn, msg) {
        conn.backlog = [];
        try {
            const r = await domain.pairing.redeem({
                robot: msg.robot || null, code: msg.code, agent_version: msg.agent_version || null,
                device_kind: msg.device_kind || 'onboard', drivers: Array.isArray(msg.drivers) ? msg.drivers : [],
                capabilities: msg.capabilities && typeof msg.capabilities === 'object' ? msg.capabilities : {}, name: msg.name || null,
            });
            attachDevice(conn, r.device);
            sendFrame(conn, 'paired', {
                device_id: r.device.id, credential: r.credential, ...domain.present.video(r),
                robot_ids: deviceRobotIds(r.device), profile_id: r.profile ? r.profile.id : null, profile: r.profile,
            });
            sendHello(conn);
            await sendConfig(conn);
            await bringOnline(conn);
        } catch (e) { deviceFailed(conn, e); }
        await drainBacklog(conn);   // after a failed pair the socket is still unpaired and the queue is answered as such
    }

    async function onTelemetry(conn, msg) {
        // Sensor samples ≤ 2 Hz. A frame carrying events (a fault, a bump, a low battery) is never dropped and
        // does not use up the samples' window, so the next sample is judged against the last sample only.
        const urgent = Array.isArray(msg.events) && msg.events.length > 0;
        if (!urgent) {
            if (now() - conn.lastTelemetry < Math.floor(1000 / config.control.telemetryHz)) return;
            conn.lastTelemetry = now();
        }
        conn.telemetry = msg;
        for (const robotId of deviceRobotIds(conn.device)) broadcast(robotId);
    }

    async function onAck(conn, msg) {
        const id = String(msg.id || '');
        if (id.startsWith('job_')) return jobs.frames.onAck(jobLink(conn), msg);   // a job's ack/nack, never a command's
        const p = pendingCmds.get(id);
        if (!p || p.deviceId !== conn.device.id) return; // unknown, already answered, or another device's command
        pendingCmds.delete(id);
        inflight.delete(p.key);
        if (p.timer) clearTimeout(p.timer);
        const result = msg.type === 'ack' ? 'ack' : 'nack';
        const latency = now() - p.at;
        cacheResult(p.key, { result, reason: msg.fault_code || null });
        await domain.audit.record({ robotId: p.robotId, deviceId: p.deviceId, subject: p.subject, operatorKind: p.operatorKind, role: p.role, kind: p.kind, value: p.value, result, reason: msg.fault_code || null, latencyMs: latency });
        sendFrame(p.conn, 'command_result', { id: p.opId, result, reason: msg.fault_code || null, latency_ms: latency });
    }

    // A device reports its own latch. It may latch a robot it is attached to; it never clears one — latched:false
    // is recorded as the device's report only, and the owner's latch stands until the owner clears it.
    async function onEstopState(conn, msg) {
        const attached = deviceRobotIds(conn.device);
        const latched = !!msg.latched;
        if (msg.robot_id != null && !attached.includes(msg.robot_id)) {
            await domain.audit.record({ robotId: String(msg.robot_id).slice(0, 64), deviceId: conn.device.id, operatorKind: 'device', kind: 'estop_state', value: { latched }, result: 'refused', reason: 'bot.forbidden' });
            return sendError(conn, 'bot.forbidden', 'this device is not attached to that robot');
        }
        for (const robotId of msg.robot_id != null ? [msg.robot_id] : attached) {
            conn.deviceEstop.set(robotId, { latched, at: iso(now()) });
            if (latched) {
                const robot = await domain.robots.get(robotId);
                if (robot && !robot.estop_latched) {
                    await domain.estop.set(robotId, { latched: true, by: conn.device.id, principalKind: 'device' });
                    await refreshConfig(robotId);
                }
            }
            broadcast(robotId);
        }
    }

    // ── Operator side ─────────────────────────────────────────────────────────────────────────────
    function authorizeControl(req) {
        const cookie = parseCookies(req.headers.cookie)[ACCESS_COOKIE];
        if (cookie) { const claims = userAuth.verify(cookie); const p = userPrincipal(claims); if (p) return p; }
        const token = bearer(req);
        if (!token) return null;
        const payload = decodePayload(token);
        if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) {
            const r = verifyService(token, { publicKey: keys.get(), issuer: config.network.issuer, audience: config.audience });
            if (!r.ok || !capabilities.grants(r.claims.cap || [], 'bot.robot.control')) return null;
            const subject = String(req.headers['x-ov-subject'] || '');
            if (!isSubject(subject)) return null;
            return { kind: 'service', sub: r.claims.sub, cap: r.claims.cap || [], subject };
        }
        const claims = userAuth.verify(token);
        return userPrincipal(claims);
    }

    function onControlSocket(ws, req) {
        const principal = authorizeControl(req);
        if (!principal) return ws.close(4002, 'sign in required');
        const conn = { ws, seq: 0, principal, subject: principal.subject, robotId: null, role: null };
        ws.conn = conn;
        ws.on('message', (raw) => handleControlMessage(conn, raw).catch((e) => { log.warn(`[Bot] control: ${e.message}`); sendError(conn, e.code || 'bot.internal', e.detail || e.message); }));
        ws.on('close', () => unsubscribe(conn));
        ws.on('error', () => { /* the close event does the work */ });
    }

    async function handleControlMessage(conn, raw) {
        let msg; try { msg = JSON.parse(String(raw)); } catch { return sendError(conn, 'bot.bad_json', 'frames must be JSON'); }
        if (!msg || typeof msg !== 'object') return sendError(conn, 'bot.bad_frame', 'a frame must be an object');
        switch (msg.type) {
            case 'join': return onJoin(conn, msg);
            case 'leave': unsubscribe(conn); conn.robotId = null; return undefined;
            case 'command': return onOperatorCommand(conn, msg);
            case 'estop': return onOperatorEstop(conn, true);
            case 'estop_clear': return onOperatorEstop(conn, false);
            default: return sendError(conn, 'bot.unknown_message', `unknown type ${msg.type}`);
        }
    }

    function subscribe(conn) { let set = subsByRobot.get(conn.robotId); if (!set) { set = new Set(); subsByRobot.set(conn.robotId, set); } set.add(conn); }
    function unsubscribe(conn) { const set = subsByRobot.get(conn.robotId); if (set) { set.delete(conn); if (!set.size) subsByRobot.delete(conn.robotId); } }

    async function onJoin(conn, msg) {
        const robotId = String(msg.robot_id || '');
        const robot = await domain.robots.get(robotId);
        if (!robot) return sendError(conn, 'bot.robot_not_found', 'no such robot');
        let role = await domain.members.roleOf(robotId, conn.subject);
        if (!role && robot.access_policy === 'queue' && conn.subject) { await domain.queue.join(robotId, conn.subject); role = 'queue'; }
        if (!role) return sendError(conn, 'bot.not_an_operator', 'you have no access to this robot');
        if (conn.robotId && conn.robotId !== robotId) unsubscribe(conn);
        conn.robotId = robotId; conn.role = role;
        subscribe(conn);
        const profileRow = await getProfile(domain.db, robot.profile_id, robot.profile_version);
        const profile = profileRow ? profileRow.profile : null;
        sendFrame(conn, 'joined', {
            robot: domain.present.robot(robot), role, profile,
            allowed_commands: domain.control.allowedFor(robot, role, profile),
            state: await robotState(robotId, conn.subject),
        });
    }

    async function onOperatorCommand(conn, msg) {
        if (!conn.robotId) return sendError(conn, 'bot.not_joined', 'join a robot first');
        // The operator's id is an idempotency key for THAT operator only (another person's id never reads or blocks
        // theirs); the device always gets a server-minted id, so an operator can never choose what a robot sees.
        const id = (msg.id != null ? String(msg.id) : prefixedId('op', now())).slice(0, 64);
        const key = `${conn.subject || `${conn.principal.kind}:${conn.principal.id || ''}`}|${id}`;
        const cached = results.get(key);
        if (cached) return sendFrame(conn, 'command_result', { id, result: cached.result, reason: cached.reason, cached: true });
        if (inflight.has(key)) return sendFrame(conn, 'command_result', { id, result: 'pending', cached: true });
        // Reserved before the first await: two frames with one id are handled concurrently, and only the first may
        // reach the robot. Every path below either hands the reservation to a pending command or releases it.
        inflight.set(key, null);
        try {
            return await sendOperatorCommand(conn, msg, id, key);
        } finally {
            if (inflight.get(key) === null) inflight.delete(key);
        }
    }

    async function sendOperatorCommand(conn, msg, id, key) {
        const robotId = conn.robotId;
        const device = deviceForRobot(robotId);
        const decision = await domain.control.prepare({ robotId, principal: conn.principal, kind: msg.kind, value: msg.value, online: !!(device && device.online), requestedMs: msg.ms });
        if (!decision.ok) {
            await domain.audit.record({ robotId, deviceId: device ? device.device.id : null, subject: conn.subject, operatorKind: conn.principal.kind, role: decision.role || conn.role, kind: msg.kind, value: msg.value || {}, result: 'refused', reason: decision.code });
            return sendFrame(conn, 'command_result', { id, result: 'refused', code: decision.code, reason: decision.reason });
        }
        const deviceCmdId = prefixedId('cmd', now());
        const frame = { v: 1, type: 'command', seq: nextSeq(device), ts: now(), id: deviceCmdId, ref: id, kind: decision.kind, value: decision.value, deadline_ms: decision.deadlineMs, operator: { subject: conn.subject, role: decision.role }, robot_id: robotId };
        if (!send(device.ws, frame)) {
            await domain.audit.record({ robotId, deviceId: device.device.id, subject: conn.subject, operatorKind: conn.principal.kind, role: decision.role, kind: decision.kind, value: decision.value, result: 'refused', reason: 'bot.device_offline' });
            return sendFrame(conn, 'command_result', { id, result: 'refused', code: 'bot.device_offline', reason: 'the device is offline' });
        }
        const p = { id: deviceCmdId, opId: id, key, deviceId: device.device.id, conn, robotId, subject: conn.subject, operatorKind: conn.principal.kind, role: decision.role, kind: decision.kind, value: decision.value, at: now(), timer: null };
        pendingCmds.set(deviceCmdId, p);
        inflight.set(key, deviceCmdId);
        const waitMs = (decision.deadlineMs ? Math.max(0, decision.deadlineMs - now()) : 1000) + 1500;
        p.timer = setTimeout(() => expireCommand(deviceCmdId), waitMs);
        if (p.timer.unref) p.timer.unref();
    }

    async function expireCommand(id) {
        const p = pendingCmds.get(id);
        if (!p) return;
        pendingCmds.delete(id);
        inflight.delete(p.key);
        cacheResult(p.key, { result: 'expired', reason: 'no acknowledgement before the deadline' });
        await domain.audit.record({ robotId: p.robotId, deviceId: p.deviceId, subject: p.subject, operatorKind: p.operatorKind, role: p.role, kind: p.kind, value: p.value, result: 'expired', reason: 'deadline' }).catch(() => {});
        sendFrame(p.conn, 'command_result', { id: p.opId, result: 'expired', reason: 'no acknowledgement before the deadline' });
    }

    function cacheResult(key, r) { results.set(key, { ...r, at: now() }); if (results.size > 4096) results.delete(results.keys().next().value); }

    /**
     * One operator command off the REST route POST /robots/:id/commands (api/v1.js): the same gate, audit
     * and per-operator idempotency as the /control socket, but the command_result is returned instead of
     * written to a socket. `principal` is the caller ({ kind, sub, cap } for a service), `subject` who it
     * acts for. Resolves with { id, result, code?, reason?, latency_ms?, cached? }.
     */
    function operatorCommand(robotId, principal, subject, msg) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
            // Every path through onOperatorCommand answers with a command_result: a cache hit or a gate
            // refusal at once, and a device command on its ack/nack or on expireCommand (which is always
            // scheduled). So the HTTP request is answered without a timeout of its own.
            const conn = {
                ws: {
                    readyState: OPEN,
                    send(raw) {
                        let frame; try { frame = JSON.parse(String(raw)); } catch { return; }
                        if (frame.type !== 'command_result') return;
                        const r = { id: frame.id != null ? String(frame.id) : null, result: frame.result };
                        if (frame.code != null) r.code = frame.code;
                        if (frame.reason != null) r.reason = frame.reason;
                        if (frame.latency_ms != null) r.latency_ms = frame.latency_ms;
                        if (frame.cached) r.cached = true;
                        finish(r);
                    },
                },
                seq: 0, principal, subject, robotId, role: null,
            };
            onOperatorCommand(conn, msg).catch((e) => { if (!settled) { settled = true; reject(e); } });
        });
    }

    async function onOperatorEstop(conn, latched) {
        if (!conn.robotId) return sendError(conn, 'bot.not_joined', 'join a robot first');
        const robotId = conn.robotId;
        try {
            if (latched) {
                const role = await domain.members.roleOf(robotId, conn.subject);
                if (!['owner', 'operator'].includes(role)) return sendError(conn, 'bot.forbidden', 'only an operator may set the e-stop');
                await domain.estop.set(robotId, { latched: true, by: conn.subject, principalKind: conn.principal.kind });
            } else {
                await domain.estop.clear(robotId, conn.subject);   // owner only; throws otherwise
            }
        } catch (e) { return sendError(conn, e.code || 'bot.forbidden', e.detail || e.message); }
        await pushEstop(robotId, latched, conn.subject);
        broadcast(robotId);
    }

    // ── Watcher side (read-only, anonymous) ───────────────────────────────────────────────────────────
    /** The caller's address as Express decides it with the same trust proxy hop count (config.trustProxy). */
    function clientAddress(req) {
        const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean).reverse();
        const chain = [req.socket.remoteAddress || '', ...forwarded];
        const hops = Number.isInteger(config.trustProxy) && config.trustProxy > 0 ? config.trustProxy : 0;
        return chain[Math.min(hops, chain.length - 1)];
    }

    function onWatchSocket(ws, req) {
        const addr = clientAddress(req);
        const conn = { ws, seq: 0, watcher: true, subject: null, robotId: null, role: 'watcher', readouts: [], addr };
        ws.conn = conn;
        watchConns.add(conn);
        watchersByAddr.set(addr, (watchersByAddr.get(addr) || 0) + 1);
        ws.on('close', () => {
            unsubscribe(conn);
            watchConns.delete(conn);
            const n = (watchersByAddr.get(addr) || 1) - 1;
            if (n > 0) watchersByAddr.set(addr, n); else watchersByAddr.delete(addr);
        });
        ws.on('error', () => { /* the close event does the work */ });
        if (watchersByAddr.get(addr) > config.watch.maxPerIp) return ws.close(4003, 'too many watchers from this address');
        ws.on('message', (raw) => handleWatchMessage(conn, raw).catch((e) => { log.warn(`[Bot] watch: ${e.message}`); sendError(conn, 'bot.internal', null); }));
        return undefined;
    }

    async function handleWatchMessage(conn, raw) {
        let msg; try { msg = JSON.parse(String(raw)); } catch { return sendError(conn, 'bot.bad_json', 'frames must be JSON'); }
        if (!msg || typeof msg !== 'object') return sendError(conn, 'bot.bad_frame', 'a frame must be an object');
        if (msg.type === 'join') return onWatchJoin(conn, msg);
        if (msg.type === 'leave') { unsubscribe(conn); conn.robotId = null; return undefined; }
        return sendError(conn, 'bot.read_only', 'this socket only watches; sign in on openvibe.bot to control');
    }

    async function onWatchJoin(conn, msg) {
        const robotId = String(msg.robot_id || '').slice(0, 64);
        const robot = robotId ? await domain.robots.get(robotId) : null;
        // An unknown robot and a robot that is not public answer alike: an anonymous caller learns nothing.
        if (!robot || !robot.embed_public) return sendError(conn, 'bot.not_an_operator', 'this robot is not public');
        if (conn.robotId !== robotId) {
            const set = subsByRobot.get(robotId);
            let watching = 0;
            if (set) for (const c of set) if (c.watcher) watching++;
            if (watching >= config.watch.maxPerRobot) return conn.ws.close(4003, 'too many watchers on this robot');
            if (conn.robotId) unsubscribe(conn);
        }
        const profileRow = await getProfile(domain.db, robot.profile_id, robot.profile_version);
        const profile = profileRow ? profileRow.profile : null;
        conn.robotId = robotId;
        conn.readouts = readoutKeys(profile);
        subscribe(conn);
        return sendFrame(conn, 'joined', { role: 'watcher', profile, allowed_commands: [], state: publicState(await robotState(robotId), conn.readouts) });
    }

    /** The owner turned embed_public off: every watcher of the robot is dropped at once. */
    function closeWatchers(robotId, reason = 'this robot is no longer public') {
        const set = subsByRobot.get(robotId);
        if (!set) return;
        for (const c of [...set]) if (c.watcher) { unsubscribe(c); try { c.ws.close(4003, reason); } catch { /* gone */ } }
    }

    // ── State and helpers ─────────────────────────────────────────────────────────────────────────
    function deviceForRobot(robotId) {
        let sim = null;
        for (const conn of deviceConns.values()) {
            if (!conn.online || !deviceRobotIds(conn.device).includes(robotId)) continue;
            if (!conn.sim) return conn;
            sim = sim || conn;
        }
        return sim;
    }
    function isOnline(deviceId) { const c = deviceConns.get(deviceId); return !!(c && c.online); }
    function sendToDevice(deviceId, fields) { const c = deviceConns.get(deviceId); return c ? sendFrame(c, fields.type, fields) : false; }
    function sendToRobotDevices(robotId, fields) {
        let any = false;
        for (const conn of deviceConns.values()) if (conn.online && deviceRobotIds(conn.device).includes(robotId)) any = sendFrame(conn, fields.type, fields) || any;
        return any;
    }
    function closeDevice(deviceId, reason = 'revoked') { const c = deviceConns.get(deviceId); if (c) { try { c.ws.close(4003, reason); } catch { /* gone */ } dropDevice(c); } }
    function deviceState(deviceId) { const c = deviceConns.get(deviceId); return c ? { online: c.online, rtt_ms: c.rttMs, telemetry: c.telemetry, status: c.status } : { online: false, rtt_ms: null, telemetry: null, status: null }; }

    // A device may report battery the legacy way (a 0..1 fraction) or as OpenVibe.Node does ({volts, percent}).
    function batteryFraction(telemetry) {
        const b = telemetry ? telemetry.battery : null;
        if (Number.isFinite(b)) return b;
        if (b && typeof b === 'object' && Number.isFinite(b.percent)) return Math.min(1, Math.max(0, b.percent / 100));
        return null;
    }

    async function robotState(robotId, subjectForQueue = null) {
        // The device's state is read before the first await, so each broadcast carries the frame that caused it
        // (two telemetry frames with events back to back are both delivered, not the second one twice).
        const conn = deviceForRobot(robotId);
        const online = !!(conn && conn.online);
        const telemetry = online && conn.telemetry ? conn.telemetry : null;
        const live = {
            latency_ms: online ? (conn.rttMs != null ? conn.rttMs : null) : null,
            battery: batteryFraction(telemetry),
            telemetry,
            status: online && conn.status ? conn.status : null,
            device_estop: online ? (conn.deviceEstop.get(robotId) || null) : null,
        };
        const robot = await domain.robots.get(robotId);
        const state = {
            robot_id: robotId, online,
            estop: robot ? { latched: !!robot.estop_latched, by: robot.estop_by || null, at: robot.estop_at ? iso(new Date(robot.estop_at).getTime()) : null } : null,
            ...live,
            queue: null,
        };
        if (robot && robot.access_policy === 'queue') state.queue = await domain.queue.state(robotId, subjectForQueue);
        return state;
    }
    /** The telemetry keys a profile's readout widgets show (`telemetry` widgets, `sensor.<key>` capabilities). */
    function readoutKeys(profile) {
        const keys = new Set();
        for (const w of (profile && profile.widgets) || []) {
            if (w && w.type === 'telemetry' && typeof w.capability === 'string' && w.capability) keys.add(w.capability.replace(/^sensor\./, ''));
        }
        return [...keys];
    }
    /**
     * What a watcher may see: online, the latch, latency, battery and the readouts' sensor values. Never the
     * queue, a subject, the device's ids, its status or the rest of its telemetry.
     */
    function publicState(state, readouts) {
        const t = state.telemetry;
        const sensors = t && t.sensors && typeof t.sensors === 'object' ? t.sensors : {};
        const picked = {};
        for (const k of readouts) if (Object.prototype.hasOwnProperty.call(sensors, k)) picked[k] = sensors[k];
        return {
            robot_id: state.robot_id, online: state.online,
            estop: { latched: !!(state.estop && state.estop.latched) },
            latency_ms: state.latency_ms, battery: state.battery,
            telemetry: t ? { sensors: picked } : null,
        };
    }
    function broadcast(robotId) {
        const subs = subsByRobot.get(robotId);
        if (!subs || !subs.size) return;
        let watched = null;   // one state for every watcher (no subject, no queue view)
        for (const sub of [...subs]) {
            if (sub.watcher) {
                watched = watched || robotState(robotId);
                watched.then((state) => sendFrame(sub, 'robot_state', { state: publicState(state, sub.readouts) })).catch(() => {});
                continue;
            }
            robotState(robotId, sub.subject).then((state) => sendFrame(sub, 'robot_state', { state })).catch(() => {});
        }
    }

    function checkHeartbeats() {
        for (const conn of [...deviceConns.values()]) {
            if (conn.node && now() > conn.node.reauthBy) {
                // The node token lapsed with no valid reauth: the machine must authenticate again.
                try { conn.ws.close(4002, 'reauth required'); } catch { /* gone */ }
                dropDevice(conn);
                continue;
            }
            if (conn.online && now() - conn.lastHeartbeat > offlineAfterMs) {
                conn.online = false;
                reportOnline(conn, false);
                for (const robotId of deviceRobotIds(conn.device)) broadcast(robotId);
            }
        }
    }

    timers.push(setInterval(() => { try { checkHeartbeats(); } catch (e) { log.warn(`[Bot] heartbeat: ${e.message}`); } }, Math.max(200, Math.floor(config.device.heartbeatMs / 2))));
    for (const t of timers) if (t.unref) t.unref();

    return {
        bindDomain(d) { domain = d; },
        bindJobs(j) { jobs = j; },
        handleUpgrade, attachSim, detachSim,
        isOnline, deviceState, sendToDevice, sendToRobotDevices, broadcast, closeDevice, robotState, refreshConfig, pushEstop, closeWatchers, operatorCommand,
        // Real devices only: a simulator is not a machine anyone runs.
        onlineCount() { let n = 0; for (const c of deviceConns.values()) if (c.online && !c.sim) n++; return n; },
        devices() { return [...deviceConns.values()].filter((c) => !c.sim).map((c) => ({ device_id: c.device.id, online: c.online })); },
        async close() {
            closed = true;
            for (const t of timers) clearInterval(t);
            for (const p of pendingCmds.values()) if (p.timer) clearTimeout(p.timer);
            pendingCmds.clear();
            inflight.clear();
            for (const conn of [...deviceConns.values()]) { try { conn.ws.close(1001, 'server closing'); } catch { /* gone */ } }
            for (const set of subsByRobot.values()) for (const conn of set) { try { conn.ws.close(1001, 'server closing'); } catch { /* gone */ } }
            for (const conn of watchConns) { try { conn.ws.close(1001, 'server closing'); } catch { /* gone */ } }
            deviceConns.clear(); subsByRobot.clear(); watchConns.clear(); watchersByAddr.clear();
            await Promise.all([
                new Promise((r) => deviceWss.close(r)), new Promise((r) => controlWss.close(r)), new Promise((r) => watchWss.close(r)),
            ]).catch(() => {});
        },
    };
}

module.exports = { createRealtime, ACCESS_COOKIE };
