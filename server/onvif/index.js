'use strict';

/**
 * The server-side ONVIF camera (camera.onvif, `mapping.driver` `onvif`): an in-process device attached to the
 * hub with hub.attachSim, beside the simulator (server/sim), for a camera Bot talks to itself rather than a
 * machine that opens a socket. Unlike the simulator it owns a real `kind: 'server'` device row
 * (domain.devices.ensureServerDevice), so the owner sees the camera as a device of the robot.
 *
 * It passes the same gate: it answers hello/config, acks commands, mirrors the e-stop and stops at a motion
 * command's deadline. A `ptz` command is translated to ONVIF ContinuousMove (Stop for zeros/halt), and a
 * GetStatus after a move is parsed into the camera readout carried by telemetry:
 *
 *   telemetry = { battery: null, sensors: {}, rtt_ms, camera: { transport: 'onvif', resolution, reachable,
 *                 ptz: { pan, tilt, zoom } | null } }
 *
 *   attach(robotId, profile)  start the camera if its profile is an `onvif` one AND BOT_ONVIF_CAMERAS names
 *                             that robot's id (no wildcard); idempotent → true/false
 *   startAll()                every existing `onvif` robot at boot
 *   stop(robotId), stopAll(), running(robotId)
 *
 * Credentials are secret references only (username_ref/password_ref, an env var name or a secret store key,
 * `resolveSecret` may be replaced): resolved when a request is built, sent as a WS-Security digest (the
 * password never travels in clear), never stored and never logged. Every request goes to the one configured
 * URL, on that one host, with a timeout and `redirect: 'error'` — a camera cannot steer Bot elsewhere.
 */
const crypto = require('crypto');
const { getProfile, listProfiles } = require('../profiles');

const isOnvifProfile = (profile) => !!(profile && profile.mapping && profile.mapping.driver === 'onvif');

const SOAP_NS = 'http://www.w3.org/2003/05/soap-envelope';
const PTZ_NS = 'http://www.onvif.org/ver20/ptz/wsdl';
const TDS_NS = 'http://www.onvif.org/ver10/device/wsdl';
const SCHEMA_NS = 'http://www.onvif.org/ver10/schema';
const WSSE_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const WSU_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const PASSWORD_DIGEST = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const NONCE_ENCODING = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';
// A camera answer is read at most this far; a GetStatus reply is a few KB, so this only ever cuts an
// endless or bogus body, which becomes an error instead of a request that never finishes.
const MAX_RESPONSE_BYTES = 64 * 1024;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/**
 * Read a fetch Response body up to `max` bytes, aborting the stream as soon as it grows past that. A camera
 * that streams an endless or oversized answer becomes an error in bounded time, never a request that hangs.
 */
async function readCapped(res, max) {
    if (!res.body || typeof res.body.getReader !== 'function') {
        const text = await res.text().catch(() => '');
        if (Buffer.byteLength(text, 'utf8') > max) throw new Error(`the camera answer exceeded ${max} bytes`);
        return text;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
            reader.cancel().catch(() => {});   // aborts the rest of the body; do not wait for it
            throw new Error(`the camera answer exceeded ${max} bytes`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** The camera's UTC time from a GetSystemDateAndTime answer, in epoch ms, or null when none can be read. */
function parseCameraTime(xml) {
    const utc = /<[^>]*UTCDateTime[^>]*>([\s\S]*?)<\/[^>]*UTCDateTime>/.exec(xml);
    const src = utc ? utc[1] : xml;
    const part = (tag) => { const m = new RegExp(`<[^>]*${tag}[^>]*>\\s*(\\d+)\\s*<`).exec(src); return m ? Number(m[1]) : null; };
    const [year, month, day, hour, minute, second] = ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second'].map(part);
    if ([year, month, day, hour, minute, second].some((v) => v == null)) return null;
    const at = Date.UTC(year, month - 1, day, hour, minute, second);
    return Number.isFinite(at) ? at : null;
}

function createOnvif({ config, domain, hub, now = () => Date.now(), log = console, fetchImpl = globalThis.fetch, env = process.env, resolveSecret = null } = {}) {
    const cameras = new Map();        // robot_id → connector state
    const opts = config.onvif || {};
    const timeoutMs = opts.timeoutMs || 5000;
    const telemetryMs = Math.ceil(1000 / Math.max(1, config.control.telemetryHz)) + 20;   // just above the hub's sample window
    const heartbeatMs = Math.max(50, Math.floor(config.device.heartbeatMs / 2));
    const every = (ms, fn) => { const t = setInterval(() => { try { fn(); } catch (e) { log.warn(`[Bot] onvif: ${e.message}`); } }, ms); if (t.unref) t.unref(); return t; };

    const cameraFor = (robotId) => opts.cameras[robotId] || null;
    const secret = resolveSecret || ((ref) => (ref ? env[ref] : null));

    // ── Attach and lifecycle ──────────────────────────────────────────────────────────────────────
    function start(robot, profile, camera, device) {
        const cam = { robotId: robot.id, robot, device, camera, profile, link: null, timers: [], stopTimer: null, estop: !!robot.estop_latched, readout: null, reachable: false, rttMs: null, clockOffsetMs: 0, at: now() };
        cameras.set(robot.id, cam);
        connect(cam);
        cam.timers.push(every(heartbeatMs, () => { if (cam.link) cam.link.deliver({ type: 'heartbeat', t: now(), rtt_ms: cam.rttMs }); }));
        cam.timers.push(every(telemetryMs, () => telemetry(cam)));
        return cam;
    }
    function connect(cam) {
        cam.link = hub.attachSim(cam.device, { onFrame: (f) => onFrame(cam, f), onClose: () => halt(cam) });
        // Sync the camera's clock (unauthenticated, as ONVIF allows) before the first authenticated request,
        // so a camera whose clock is a few seconds off still accepts the WS-Security digest.
        if (cam.link) cam.link.ready.then(() => syncClock(cam), () => {}).then(() => { refreshStatus(cam); telemetry(cam); });
    }

    /** Start the camera for a robot whose profile's driver is `onvif` and that BOT_ONVIF_CAMERAS names (idempotent). */
    async function attach(robotOrId, profile) {
        const robot = typeof robotOrId === 'string' ? await domain.robots.get(robotOrId) : robotOrId;
        if (!robot) return false;
        if (cameras.has(robot.id)) return true;
        if (profile === undefined) {
            const row = await getProfile(domain.db, robot.profile_id, robot.profile_version);
            profile = row && row.profile;
        }
        if (!isOnvifProfile(profile)) return false;
        const camera = cameraFor(robot.id);
        if (!camera) return false;
        const resolution = (profile.camera && profile.camera.resolution) || null;
        const device = await domain.devices.ensureServerDevice({
            id: `dev_onvif_${robot.id}`, robotId: robot.id, name: 'onvif camera',
            drivers: ['onvif'], capabilities: { camera: { transport: 'onvif', resolution } },
        });
        if (!device) { log.warn(`[Bot] onvif: no device row for ${robot.id}`); return false; }
        start(robot, profile, camera, device);
        return true;
    }

    async function startAll() {
        const ids = (await listProfiles(domain.db)).filter((r) => isOnvifProfile(r.profile)).map((r) => r.id);
        if (!ids.length) return 0;
        const robots = await domain.db.many('SELECT * FROM robots WHERE profile_id = ANY($1)', [ids]);
        let n = 0;
        for (const robot of robots) if (await attach(robot)) n++;
        return n;
    }

    function stop(robotId) {
        const cam = cameras.get(robotId);
        if (!cam) return;
        cameras.delete(robotId);
        for (const t of cam.timers) clearInterval(t);
        stopTimerClear(cam);
        cam.link = null;
        hub.detachSim(cam.device.id);
    }
    function stopAll() { for (const id of [...cameras.keys()]) stop(id); }

    // ── Frames from the hub ───────────────────────────────────────────────────────────────────────
    function onFrame(cam, f) {
        if (f.type === 'config') { cam.estop = !!f.estop_latched; if (cam.estop) halt(cam); return; }
        if (f.type === 'estop') { cam.estop = !!f.latched; if (cam.estop) halt(cam); return; }
        if (f.type !== 'command') return;
        const reply = (fields) => cam.link && cam.link.deliver({ id: f.id, ...fields });
        if (f.kind === 'halt') { halt(cam); return reply({ type: 'ack' }); }
        if (cam.estop) return reply({ type: 'nack', fault_code: 'estop_latched' });
        if (f.kind !== 'ptz') return reply({ type: 'nack', fault_code: 'bot.unknown_command' });
        return ptz(cam, f, reply);
    }

    async function ptz(cam, f, reply) {
        const v = f.value || {};
        const axes = { pan: num(v.pan), tilt: num(v.tilt), zoom: num(v.zoom) };
        try {
            if (!axes.pan && !axes.tilt && !axes.zoom) await request(cam, stopBody(cam));
            else { await request(cam, moveBody(cam, axes)); scheduleStop(cam, f.deadline_ms); }
            if (axes.pan || axes.tilt || axes.zoom) refreshStatus(cam);   // the readout follows the move
            return reply({ type: 'ack' });
        } catch (e) {
            return reply({ type: 'nack', fault_code: 'bot.onvif_unreachable' });
        }
    }

    function halt(cam) {
        stopTimerClear(cam);
        stopWithRetry(cam);
    }
    function stopTimerClear(cam) { if (cam.stopTimer) clearTimeout(cam.stopTimer); cam.stopTimer = null; }
    /** A Stop is safety-critical: try once, retry a failure once, then log the robot id (never the URL or secrets). */
    async function stopWithRetry(cam) {
        try { await request(cam, stopBody(cam)); return; }
        catch { /* one retry below */ }
        try { await request(cam, stopBody(cam)); }
        catch { log.warn(`[Bot] onvif: stop failed for robot ${cam.robotId}`); }
    }
    /**
     * The deadman: a ContinuousMove stops by itself at the command's deadline unless a newer one arrived. A
     * frame without a finite deadline (an older or direct caller) still gets one — the robot's own
     * maxCommandMs — so a continuous move is never left running.
     */
    function scheduleStop(cam, deadline) {
        stopTimerClear(cam);
        const at = Number.isFinite(deadline) ? deadline : now() + camMaxCommandMs(cam);
        cam.stopTimer = setTimeout(() => { cam.stopTimer = null; stopWithRetry(cam); }, Math.max(0, at - now()));
        if (cam.stopTimer.unref) cam.stopTimer.unref();
    }
    function camMaxCommandMs(cam) {
        try { return domain.control.effectiveLimits(cam.robot, cam.profile).maxCommandMs; }
        catch { return config.control.maxCommandMs; }
    }

    // ── ONVIF over HTTP (the one configured host, with a timeout) ─────────────────────────────────
    async function request(cam, envelope) {
        const started = now();
        let res;
        try {
            res = await fetchImpl(cam.camera.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', Accept: 'application/soap+xml' },
                body: envelope,
                redirect: 'error',                       // never follow a camera to another host
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e) {
            cam.reachable = false;
            throw new Error(`the camera did not answer within ${timeoutMs} ms`);
        }
        cam.rttMs = Math.max(0, Math.round(now() - started));
        if (!res.ok) { cam.reachable = false; throw new Error(`the camera answered ${res.status}`); }
        let text;
        try { text = await readCapped(res, MAX_RESPONSE_BYTES); }
        catch (e) { cam.reachable = false; throw e; }
        cam.reachable = true;
        return text;
    }

    async function refreshStatus(cam) {
        try {
            const xml = await request(cam, statusBody(cam));
            if (!/<[^>]*GetStatusResponse[\s>]/.test(xml)) return;   // never read a position out of any other reply
            const read = parseStatus(xml);
            if (read) cam.readout = read;
        } catch { /* telemetry carries reachable: false until the camera answers again */ }
    }

    /**
     * Ask the camera for its time once (GetSystemDateAndTime is unauthenticated, as ONVIF allows) and remember
     * the offset, so the WS-Security Created matches the camera's clock and a camera a few seconds off still
     * accepts the digest. A camera without the call, or an answer we cannot read, leaves local time in place.
     */
    async function syncClock(cam) {
        try {
            const xml = await request(cam, envelope('', `<tds:GetSystemDateAndTime xmlns:tds="${TDS_NS}"/>`));
            const at = parseCameraTime(xml);
            if (at != null) cam.clockOffsetMs = at - now();
        } catch { /* keep local time */ }
    }

    function telemetry(cam) {
        if (!cam.link) return;
        cam.link.deliver({
            type: 'telemetry',
            battery: null,
            sensors: {},
            camera: {
                transport: 'onvif',
                resolution: (cam.profile.camera && cam.profile.camera.resolution) || null,
                reachable: cam.reachable,
                ptz: cam.readout,
            },
            rtt_ms: cam.rttMs,
        });
    }

    // ── SOAP, with the credentials resolved only here and sent as a WS-Security digest ─────────────
    function securityHeader(cam) {
        const username = secret(cam.camera.usernameRef);
        const password = secret(cam.camera.passwordRef);
        if (!username || !password) return '';
        const nonce = crypto.randomBytes(16);
        const created = new Date(now() + (cam.clockOffsetMs || 0)).toISOString();
        const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(String(password))])).digest('base64');
        return `<s:Header><wsse:Security xmlns:wsse="${WSSE_NS}" xmlns:wsu="${WSU_NS}" s:mustUnderstand="1">`
            + `<wsse:UsernameToken><wsse:Username>${esc(username)}</wsse:Username>`
            + `<wsse:Password Type="${PASSWORD_DIGEST}">${digest}</wsse:Password>`
            + `<wsse:Nonce EncodingType="${NONCE_ENCODING}">${nonce.toString('base64')}</wsse:Nonce>`
            + `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`;
    }
    const envelope = (header, body) => `<?xml version="1.0" encoding="UTF-8"?>`
        + `<s:Envelope xmlns:s="${SOAP_NS}" xmlns:tptz="${PTZ_NS}" xmlns:tt="${SCHEMA_NS}">${header}<s:Body>${body}</s:Body></s:Envelope>`;
    const token = (cam) => `<tptz:ProfileToken>${esc(cam.camera.profileToken)}</tptz:ProfileToken>`;

    function moveBody(cam, a) {
        const velocity = [];
        if (a.pan || a.tilt) velocity.push(`<tt:PanTilt x="${a.pan}" y="${a.tilt}"/>`);
        if (a.zoom) velocity.push(`<tt:Zoom x="${a.zoom}"/>`);
        return envelope(securityHeader(cam), `<tptz:ContinuousMove>${token(cam)}<tptz:Velocity>${velocity.join('')}</tptz:Velocity></tptz:ContinuousMove>`);
    }
    const stopBody = (cam) => envelope(securityHeader(cam), `<tptz:Stop>${token(cam)}<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`);
    const statusBody = (cam) => envelope(securityHeader(cam), `<tptz:GetStatus>${token(cam)}</tptz:GetStatus>`);

    /** The PTZ position from a GetStatus answer: { pan, tilt, zoom } when one is present, else null. */
    function parseStatus(xml) {
        const pt = /<[^>]*PanTilt[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"/.exec(xml);
        const z = /<[^>]*Zoom[^>]*\bx="([^"]+)"/.exec(xml);
        if (!pt && !z) return null;
        return { pan: pt ? num(pt[1]) : 0, tilt: pt ? num(pt[2]) : 0, zoom: z ? num(z[1]) : 0 };
    }

    return { attach, startAll, stop, stopAll, running: (robotId) => cameras.has(robotId), isOnvifProfile, cameraFor };
}

module.exports = { createOnvif, isOnvifProfile };
