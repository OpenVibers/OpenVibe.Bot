'use strict';

/**
 * The two WebSockets (ADR-043 decisions 4, 5 and 8), one hub for both.
 *
 *   wss://…/device    one outbound connection per device. Auth by `Authorization: Bearer <credential>`
 *                     on the upgrade, never a query string; an unauthenticated socket may only send
 *                     `pair`. Heartbeats every 1 s; offline after 2 missed + 3 s grace. Commands are
 *                     never queued for an offline device and never replayed after a reconnect.
 *   wss://…/control   a signed-in person (Network session cookie or Bearer) or a service token holding
 *                     `bot.robot.control` acting for `X-OV-Subject`. Joins a robot, sends commands; the
 *                     gate lives in the domain and every decision is audited.
 *
 * Every frame carries v, seq, ts. A command's `id` is an idempotency key: a repeated id answers with the
 * first result instead of reaching the device again.
 */
const { WebSocketServer } = require('ws');
const { capabilities, ids } = require('openvibe-contracts');
const { json, iso, prefixedId } = require('./util');
const { userPrincipal, verifyService, PRINCIPAL_SUB, decodePayload } = require('./api/auth');
const { getProfile } = require('./profiles');

const OPEN = 1;
const ACCESS_COOKIE = 'ov_token';

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
    const offlineAfterMs = config.device.heartbeatMs * config.device.offlineMisses + config.device.offlineGraceMs;

    const nextSeq = (conn) => ++conn.seq;
    function send(ws, obj) { if (ws.readyState === OPEN) { ws.send(JSON.stringify(obj)); return true; } return false; }
    function sendFrame(conn, type, fields) { return send(conn.ws, { v: 1, seq: nextSeq(conn), ts: now(), type, ...fields }); }
    function sendError(conn, code, detail) { return sendFrame(conn, 'error', { code, detail: detail || null }); }
    const deviceRobotIds = (device) => json(device.robot_ids, []);

    // ── Upgrade routing ───────────────────────────────────────────────────────────────────────────
    function handleUpgrade(req, socket, head) {
        if (closed) return socket.destroy();
        let path;
        try { path = new URL(req.url, 'http://localhost').pathname; } catch { return socket.destroy(); }
        if (path === '/device') return deviceWss.handleUpgrade(req, socket, head, (ws) => onDeviceSocket(ws, req));
        if (path === '/control') return controlWss.handleUpgrade(req, socket, head, (ws) => onControlSocket(ws, req));
        socket.destroy();
    }

    // ── Device side ───────────────────────────────────────────────────────────────────────────────
    async function onDeviceSocket(ws, req) {
        const conn = { ws, seq: 0, pending: true, device: null, online: false, rttMs: null, telemetry: null, status: null, lastHeartbeat: now(), lastTelemetry: 0, sessionId: prefixedId('sess', now()) };
        ws.conn = conn;
        ws.on('message', (raw) => handleDeviceMessage(conn, raw).catch((e) => { log.warn(`[Bot] device ${conn.device ? conn.device.id : '?'}: ${e.message}`); sendError(conn, e.code || 'bot.internal', e.detail || e.message); }));
        ws.on('close', () => dropDevice(conn));
        ws.on('error', () => { /* the close event does the work */ });
        const cred = bearer(req);   // the query string is never read
        if (cred) {
            try {
                await authenticateDevice(conn, cred);
                sendHello(conn);
                await sendConfig(conn);
                await bringOnline(conn);
            } catch (e) { log.warn(`[Bot] device auth: ${e.message}`); ws.close(4002, 'invalid credential'); }
        }
    }

    async function authenticateDevice(conn, credential) {
        const device = await domain.devices.byCredential(credential);
        if (!device) throw new Error('unknown or revoked credential');
        attachDevice(conn, device);
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
    /** Re-send `config` to the robot's connected devices (the owner changed its limits). */
    async function refreshConfig(robotId) {
        for (const conn of [...deviceConns.values()]) {
            if (conn.online && deviceRobotIds(conn.device).includes(robotId)) await sendConfig(conn);
        }
    }
    async function bringOnline(conn) {
        await domain.devices.setOnline(conn.device, true).catch((e) => log.warn(`[Bot] online event: ${e.message}`));
        for (const robotId of deviceRobotIds(conn.device)) broadcast(robotId);
    }

    function dropDevice(conn, { silent = false } = {}) {
        if (!conn || !conn.device) return;
        const current = deviceConns.get(conn.device.id);
        if (current === conn) deviceConns.delete(conn.device.id);
        if (!conn.online) return;
        conn.online = false;
        if (silent) return;
        domain.devices.setOnline(conn.device, false).catch((e) => log.warn(`[Bot] offline event: ${e.message}`));
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
            case 'heartbeat':
                if (Number.isFinite(msg.rtt_ms)) conn.rttMs = Math.round(msg.rtt_ms);
                return sendFrame(conn, 'heartbeat_ack', { seq: msg.seq, server_time: iso(now()) });
            case 'telemetry': return onTelemetry(conn, msg);
            case 'status': conn.status = msg; for (const r of deviceRobotIds(conn.device)) broadcast(r); return undefined;
            case 'ack': case 'nack': return onAck(conn, msg);
            case 'estop_state': return onEstopState(conn, msg);
            default: return sendError(conn, 'bot.unknown_message', `unknown type ${msg.type}`);
        }
    }

    async function handlePair(conn, msg) {
        const r = await domain.pairing.redeem({
            robot: msg.robot || null, code: msg.code, agent_version: msg.agent_version || null,
            device_kind: msg.device_kind || 'onboard', drivers: Array.isArray(msg.drivers) ? msg.drivers : [],
            capabilities: msg.capabilities && typeof msg.capabilities === 'object' ? msg.capabilities : {}, name: msg.name || null,
        });
        attachDevice(conn, r.device);
        sendFrame(conn, 'paired', {
            device_id: r.device.id, credential: r.credential, publish_key: r.publish_key, whip_url: r.whip_url,
            robot_ids: deviceRobotIds(r.device), profile_id: r.profile ? r.profile.id : null, profile: r.profile,
        });
        sendHello(conn);
        await sendConfig(conn);
        await bringOnline(conn);
    }

    async function onTelemetry(conn, msg) {
        if (now() - conn.lastTelemetry < Math.floor(1000 / config.control.telemetryHz)) return;   // ≤ 2 Hz
        conn.lastTelemetry = now();
        conn.telemetry = msg;
        for (const robotId of deviceRobotIds(conn.device)) broadcast(robotId);
    }

    async function onAck(conn, msg) {
        const id = String(msg.id || '');
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

    async function onEstopState(conn, msg) {
        const robotIds = msg.robot_id ? [msg.robot_id] : deviceRobotIds(conn.device);
        for (const robotId of robotIds) {
            const robot = await domain.robots.get(robotId);
            if (!robot || !!robot.estop_latched === !!msg.latched) continue;
            await domain.estop.set(robotId, { latched: !!msg.latched, by: 'device', principalKind: 'device' });
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
        sendToRobotDevices(robotId, { type: 'estop', latched, by: conn.subject, at: iso(now()) });
        broadcast(robotId);
    }

    // ── State and helpers ─────────────────────────────────────────────────────────────────────────
    function deviceForRobot(robotId) {
        for (const conn of deviceConns.values()) if (conn.online && deviceRobotIds(conn.device).includes(robotId)) return conn;
        return null;
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

    async function robotState(robotId, subjectForQueue = null) {
        const robot = await domain.robots.get(robotId);
        const conn = deviceForRobot(robotId);
        const online = !!(conn && conn.online);
        const state = {
            robot_id: robotId, online,
            estop: robot ? { latched: !!robot.estop_latched, by: robot.estop_by || null, at: robot.estop_at ? iso(new Date(robot.estop_at).getTime()) : null } : null,
            latency_ms: online ? (conn.rttMs != null ? conn.rttMs : null) : null,
            battery: online && conn.telemetry ? (conn.telemetry.battery != null ? conn.telemetry.battery : null) : null,
            telemetry: online && conn.telemetry ? conn.telemetry : null,
            status: online && conn.status ? conn.status : null,
            queue: null,
        };
        if (robot && robot.access_policy === 'queue') state.queue = await domain.queue.state(robotId, subjectForQueue);
        return state;
    }
    function broadcast(robotId) {
        const subs = subsByRobot.get(robotId);
        if (!subs || !subs.size) return;
        for (const sub of [...subs]) {
            robotState(robotId, sub.subject).then((state) => sendFrame(sub, 'robot_state', { state })).catch(() => {});
        }
    }

    function checkHeartbeats() {
        for (const conn of [...deviceConns.values()]) {
            if (conn.online && now() - conn.lastHeartbeat > offlineAfterMs) {
                conn.online = false;
                domain.devices.setOnline(conn.device, false).catch((e) => log.warn(`[Bot] offline event: ${e.message}`));
                for (const robotId of deviceRobotIds(conn.device)) broadcast(robotId);
            }
        }
    }

    timers.push(setInterval(() => { try { checkHeartbeats(); } catch (e) { log.warn(`[Bot] heartbeat: ${e.message}`); } }, Math.max(200, Math.floor(config.device.heartbeatMs / 2))));
    for (const t of timers) if (t.unref) t.unref();

    return {
        bindDomain(d) { domain = d; },
        handleUpgrade,
        isOnline, deviceState, sendToDevice, sendToRobotDevices, broadcast, closeDevice, robotState, refreshConfig,
        onlineCount() { let n = 0; for (const c of deviceConns.values()) if (c.online) n++; return n; },
        devices() { return [...deviceConns.values()].map((c) => ({ device_id: c.device.id, online: c.online })); },
        async close() {
            closed = true;
            for (const t of timers) clearInterval(t);
            for (const p of pendingCmds.values()) if (p.timer) clearTimeout(p.timer);
            pendingCmds.clear();
            inflight.clear();
            for (const conn of [...deviceConns.values()]) { try { conn.ws.close(1001, 'server closing'); } catch { /* gone */ } }
            for (const set of subsByRobot.values()) for (const conn of set) { try { conn.ws.close(1001, 'server closing'); } catch { /* gone */ } }
            deviceConns.clear(); subsByRobot.clear();
            await Promise.all([
                new Promise((r) => deviceWss.close(r)), new Promise((r) => controlWss.close(r)),
            ]).catch(() => {});
        },
    };
}

module.exports = { createRealtime, ACCESS_COOKIE };
