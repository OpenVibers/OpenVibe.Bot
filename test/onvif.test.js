'use strict';
// The server-side ONVIF camera (camera.onvif, server/onvif): an in-process device attached beside the
// simulator, but with a real `kind: 'server'` device row and one outbound ONVIF request per ptz command.
// Against a stub ONVIF endpoint this checks a ptz command becomes a ContinuousMove (with the credentials as a
// WS-Security digest, never in clear) and that telemetry carries the camera's GetStatus readout. The request
// only ever goes to the configured host, with a timeout, and BOT_ONVIF_CAMERAS refuses a URL that would
// carry credentials, a non-http(s) scheme, or a key that is not a robot id (no wildcard) at boot.
//
// Also, away from the stub endpoint: an oversized answer is an error rather than a hang; a move with no
// deadline still gets a Stop at the robot's maxCommandMs; a failed Stop is retried once and then logged with
// the robot id alone; and a camera whose clock is minutes ahead gets a WS-Security Created matching its clock.
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/app');
const { loadConfig } = require('../server/config');
const { createOnvif } = require('../server/onvif');

const CAM_USER = 'onvif-operator';
const CAM_PASS = 'sup3r-secret-pass';
const ROB = 'rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X';   // an id a robot could have; "*" and other keys are refused
const TT = 'http://www.onvif.org/ver10/schema';
const TDS = 'http://www.onvif.org/ver10/device/wsdl';

const statusXml = '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
    + '<s:Body><tptz:GetStatusResponse xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"><tptz:PTZStatus>'
    + '<tt:Position xmlns:tt="' + TT + '"><tt:PanTilt x="0.25" y="-0.5"/><tt:Zoom x="0.1"/></tt:Position>'
    + '<tt:MoveStatus><tt:PanTilt>IDLE</tt:PanTilt><tt:Zoom>IDLE</tt:Zoom></tt:MoveStatus>'
    + '</tptz:PTZStatus></tptz:GetStatusResponse></s:Body></s:Envelope>';
const okXml = '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body/></s:Envelope>';

/** A GetSystemDateAndTime answer whose UTC clock is `skewMs` from the local one. */
function dateTimeXml(skewMs) {
    const d = new Date(Date.now() + skewMs);
    return '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>'
        + '<tds:GetSystemDateAndTimeResponse xmlns:tds="' + TDS + '"><tds:SystemDateAndTime>'
        + '<tt:UTCDateTime xmlns:tt="' + TT + '"><tt:Date>'
        + `<tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date>`
        + `<tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>`
        + '</tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse></s:Body></s:Envelope>';
}

/** A stub ONVIF PTZ service: records every request and answers GetStatus, GetSystemDateAndTime and moves. */
function startCamera({ skewMs = 0 } = {}) {
    return new Promise((resolve) => {
        const calls = [];
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (d) => chunks.push(d));
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                calls.push({ method: req.method, path: req.url, host: req.headers.host, contentType: req.headers['content-type'] || '', body });
                res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
                if (body.includes('GetSystemDateAndTime')) return res.end(dateTimeXml(skewMs));
                if (body.includes('GetStatus')) return res.end(statusXml);
                res.end(okXml);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/onvif/ptz_service`, calls, close: () => new Promise((r) => server.close(r)) }));
    });
}

/**
 * A stub camera that streams an oversized body (256 KB) and then leaves the connection open. Reading it must
 * cut off at the cap in bounded time; without the cap, res.text() would wait for an end that never comes.
 */
function startHugeCamera() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            req.on('data', () => {});
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
                res.on('error', () => {});
                res.write(Buffer.alloc(256 * 1024, 0x61));   // 256 KB of 'a', then no end()
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}/onvif/ptz_service`,
            close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }),
        }));
    });
}

async function poll(fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) return null;
        await new Promise((r) => setTimeout(r, 25));
    }
}

const cameraEntry = (url) => ({ url, usernameRef: 'CAM_USER', passwordRef: 'CAM_PASS', profileToken: 'profile_1' });

/**
 * A connector wired to fakes, so a raw command frame (with no deadline_ms, as only an older or direct caller
 * would send) can be pushed through the same onFrame a hub uses.
 */
function unitOnvif({ fetchImpl, log = { warn() {} } } = {}) {
    const robot = { id: ROB, limits: {} };
    const profile = { mapping: { driver: 'onvif' }, camera: { resolution: null }, limits: {} };
    const camera = { url: 'http://cam.test/onvif/ptz_service', usernameRef: null, passwordRef: null, profileToken: 'profile_1' };
    const links = new Map();
    const hub = {
        attachSim(device, { onFrame }) { const link = { onFrame, ready: Promise.resolve(), deliver() {} }; links.set(device.id, link); return link; },
        detachSim(id) { links.delete(id); },
    };
    const domain = {
        robots: { get: async (id) => (id === robot.id ? robot : null) },
        devices: { ensureServerDevice: async () => ({ id: `dev_onvif_${robot.id}`, robot_ids: [robot.id], kind: 'server' }) },
        control: { effectiveLimits: () => ({ maxCommandMs: 80, maxSpeed: 1, maxTurn: 1, cooldownMs: 0 }) },
        db: {},
    };
    const config = { onvif: { cameras: { [ROB]: camera }, timeoutMs: 2000 }, control: { telemetryHz: 2, maxCommandMs: 80 }, device: { heartbeatMs: 1000 } };
    const onvif = createOnvif({ config, domain, hub, log, fetchImpl: fetchImpl || (async () => new Response(okXml, { status: 200 })) });
    return { onvif, robot, profile, camera, links };
}

(async () => {
    await check('BOT_ONVIF_CAMERAS is validated at boot: a non-robot key (no wildcard), a bad URL, scheme or credential refuses', () => {
        const parse = (v) => { try { loadConfig({ BOT_ONVIF_CAMERAS: v }); return null; } catch (e) { return e.message; } };
        assert.match(parse('not json'), /BOT_ONVIF_CAMERAS must be JSON/);
        assert.match(parse('[]'), /must be a JSON object/);
        // A camera names one robot: "*" and any other non-robot key refuse, so no camera is ever shared.
        assert.match(parse(JSON.stringify({ '*': { url: 'http://cam/x' } })), /not a robot id/);
        assert.match(parse(JSON.stringify({ rob_x: { url: 'http://cam/x' } })), /not a robot id/);
        assert.match(parse(JSON.stringify({ '': { url: 'http://cam/x' } })), /not a robot id/);
        assert.match(parse(JSON.stringify({ [ROB]: { url: 'ftp://cam/x' } })), /http\(s\)/);
        assert.match(parse(JSON.stringify({ [ROB]: { url: 'http://user:pw@cam/x' } })), /must carry no credentials/);
        assert.match(parse(JSON.stringify({ [ROB]: { url: 'http://cam/x', username_ref: 'U' } })), /both username_ref and password_ref/);
        assert.match(parse(JSON.stringify({ [ROB]: { url: 'http://cam/x', password_ref: 'P' } })), /both username_ref and password_ref/);
        // The ref, not the value, is what config keeps.
        const c = loadConfig({ BOT_ONVIF_CAMERAS: JSON.stringify({ [ROB]: { url: 'http://cam/x', username_ref: 'CAM_USER', password_ref: 'CAM_PASS' } }) });
        assert.deepStrictEqual(c.onvif.cameras[ROB], { url: 'http://cam/x', usernameRef: 'CAM_USER', passwordRef: 'CAM_PASS', profileToken: 'profile_1' });
        assert.strictEqual(c.onvif.cameras['*'], undefined, 'no wildcard entry survives parsing');
        assert.strictEqual(JSON.stringify(c).includes(CAM_PASS), false, 'no secret value appears in the config');
    });

    const cam = await startCamera();
    const skewed = await startCamera({ skewMs: 5 * 60 * 1000 });   // the camera's clock is 5 minutes ahead
    const huge = await startHugeCamera();
    process.env.CAM_USER = CAM_USER;
    process.env.CAM_PASS = CAM_PASS;
    const t = await boot({
        env: {
            BOT_ONVIF_CAMERAS: JSON.stringify({ [ROB]: cameraEntry(cam.url) }),
            BOT_ONVIF_TIMEOUT_MS: '8000',
        },
    });
    const alex = t.network.newUser('alex');
    // The boot camera names one placeholder robot; the real robot ids are only known after the app boots, so
    // the tests point the connector at a camera per robot the way an operator's config would.
    const plot = (robotId, url = cam.url) => { t.config.onvif.cameras[robotId] = cameraEntry(url); return robotId; };

    await check('an onvif robot attaches in-process: a kind:server device row, no sim count, GetStatus readout', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'camera.onvif' });
        assert.strictEqual(await t.app.locals.onvif.attach(plot(robot.id)), true);
        assert.strictEqual(t.app.locals.onvif.running(robot.id), true);
        // The device row: a server device of this robot, drivers ['onvif'], and no credential handed out.
        const row = await t.db.maybe('SELECT * FROM devices WHERE id = $1', [`dev_onvif_${robot.id}`]);
        assert.ok(row, 'a devices row was written');
        assert.strictEqual(row.kind, 'server');
        assert.deepStrictEqual(row.robot_ids, [robot.id]);
        assert.deepStrictEqual(row.drivers, ['onvif']);
        assert.strictEqual(row.capabilities.camera.transport, 'onvif');
        assert.strictEqual(row.capabilities.camera.resolution, '1920x1080');
        assert.strictEqual(row.last_seen, null, 'a server camera is not reported as a device seen over /device');
        assert.ok(!JSON.stringify(row).includes(CAM_PASS), 'the device row holds no camera secret');
        // It passes the hub like a device, but is not counted among machines (like the simulator).
        assert.strictEqual(t.hub.isOnline(`dev_onvif_${robot.id}`), true);
        assert.strictEqual(t.hub.onlineCount(), 0, 'a server camera is not a machine anyone runs');
        // The clock sync is asked once, unauthenticated (the camera answers; no token on that request).
        assert.ok(await poll(() => cam.calls.some((c) => c.body.includes('GetSystemDateAndTime')), 2000), 'GetSystemDateAndTime was called');
        const sync = cam.calls.find((c) => c.body.includes('GetSystemDateAndTime'));
        assert.ok(!sync.body.includes('UsernameToken') && !sync.body.includes('#PasswordDigest'), 'the clock sync carries no credentials');
        // Telemetry carries the camera readout parsed from GetStatus.
        const state = await poll(() => {
            const s = t.hub.deviceState(`dev_onvif_${robot.id}`);
            return s.telemetry && s.telemetry.camera && s.telemetry.camera.ptz ? s : null;
        }, 2000);
        assert.ok(state, 'telemetry with a readout within 2 s');
        assert.deepStrictEqual(state.telemetry.camera.ptz, { pan: 0.25, tilt: -0.5, zoom: 0.1 });
        assert.strictEqual(state.telemetry.camera.reachable, true);
        assert.ok(Number.isFinite(state.telemetry.rtt_ms), 'the readout carries the round trip');
        assert.ok(cam.calls.some((c) => c.body.includes('GetStatus')), 'the readout came from a GetStatus request');
    });

    await check('a camera configured for one robot is never attached to another (no wildcard fallback)', async () => {
        const a = (await t.robot(alex, { profile_id: 'camera.onvif' })).robot;
        const b = (await t.robot(alex, { profile_id: 'camera.onvif' })).robot;
        plot(a.id);
        assert.strictEqual(await t.app.locals.onvif.attach(a.id), true, 'the named robot attaches');
        assert.strictEqual(await t.app.locals.onvif.attach(b.id), false, 'a robot with no camera entry is left alone');
        assert.strictEqual(t.app.locals.onvif.running(b.id), false);
    });

    await check('a ptz command becomes an ONVIF ContinuousMove to the configured host, and is acked', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'camera.onvif' });
        assert.strictEqual(await t.app.locals.onvif.attach(plot(robot.id)), true);
        const before = cam.calls.length;
        const op = await t.ws('/control', { headers: { Authorization: `Bearer ${t.network.signUser(alex)}` } });
        op.send({ type: 'join', robot_id: robot.id });
        await op.waitFor((m) => m.type === 'joined');
        op.send({ type: 'command', id: 'p1', kind: 'ptz', value: { pan: 0.5, tilt: -0.25, zoom: 0 } });
        const res = await op.waitFor((m) => m.type === 'command_result' && m.id === 'p1');
        assert.strictEqual(res.result, 'ack', res.reason || JSON.stringify(res));

        const calls = cam.calls.slice(before);
        const move = calls.find((c) => c.body.includes('ContinuousMove'));
        assert.ok(move, 'the command became a ContinuousMove');
        assert.strictEqual(move.method, 'POST');
        assert.strictEqual(move.path, '/onvif/ptz_service');
        assert.match(move.contentType, /application\/soap\+xml/);
        assert.ok(move.body.includes('<tt:PanTilt x="0.5" y="-0.25"/>'), 'the pan/tilt velocity is translated');
        // Every request went to the one configured host, soap only.
        for (const c of cam.calls) assert.strictEqual(c.host, new URL(cam.url).host, 'no request left the configured host');
        // Credentials ride as a WS-Security digest, never the clear password, and are never logged.
        assert.ok(move.body.includes('<wsse:UsernameToken>') && move.body.includes(`<wsse:Username>${CAM_USER}</wsse:Username>`), 'the username is in the token');
        assert.ok(move.body.includes('#PasswordDigest'), 'the password is digested');
        assert.ok(!move.body.includes(CAM_PASS), 'the password is never sent in clear');
        assert.ok(!t.logs.join('\n').includes(CAM_PASS), 'the password is never logged');
        const state = await op.waitFor((m) => m.type === 'robot_state' && m.state && m.state.telemetry && m.state.telemetry.camera);
        assert.ok(state && state.state.telemetry.camera.ptz, 'the operator sees the camera readout');
        op.close();
    });

    await check('halt sends an ONVIF Stop; a ptz command nacks when the camera is unreachable', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'camera.onvif' });
        await t.app.locals.onvif.attach(plot(robot.id));
        const before = cam.calls.length;
        const op = await t.ws('/control', { headers: { Authorization: `Bearer ${t.network.signUser(alex)}` } });
        op.send({ type: 'join', robot_id: robot.id });
        await op.waitFor((m) => m.type === 'joined');
        op.send({ type: 'command', id: 'h1', kind: 'halt', value: {} });
        const res = await op.waitFor((m) => m.type === 'command_result' && m.id === 'h1');
        assert.strictEqual(res.result, 'ack');
        assert.ok(await poll(() => cam.calls.slice(before).some((c) => c.body.includes('<tptz:Stop>')), 1000), 'a Stop reached the camera');

        // The camera goes away: a ptz command is nacked, never left pending.
        await cam.close();
        op.send({ type: 'command', id: 'p2', kind: 'ptz', value: { zoom: 0.5 } });
        const down = await op.waitFor((m) => m.type === 'command_result' && m.id === 'p2');
        assert.strictEqual(down.result, 'nack');
        assert.strictEqual(down.reason, 'bot.onvif_unreachable');
        op.close();
    });

    await check('a profile that is not the onvif driver is never attached by the connector', async () => {
        const { robot } = await t.robot(alex, { name: 'Rover' });   // sim.rover
        assert.strictEqual(await t.app.locals.onvif.attach(robot.id), false, 'a sim robot is left to the simulator');
        assert.strictEqual(t.app.locals.onvif.running(robot.id), false);
    });

    await check('startAll attaches every onvif robot that has a configured camera', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'camera.onvif' });
        plot(robot.id);
        t.app.locals.onvif.stopAll();
        const n = await t.app.locals.onvif.startAll();
        assert.ok(n >= 1, `startAll attached the onvif robots (${n})`);
        assert.strictEqual(t.app.locals.onvif.running(robot.id), true);
        t.app.locals.onvif.stopAll();
        assert.strictEqual(t.app.locals.onvif.running(robot.id), false);
        assert.strictEqual(t.hub.isOnline(`dev_onvif_${robot.id}`), false);
    });

    await check('an oversized camera answer is an error in bounded time, not a hang', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'camera.onvif' });
        assert.strictEqual(await t.app.locals.onvif.attach(plot(robot.id, huge.url)), true);
        const op = await t.ws('/control', { headers: { Authorization: `Bearer ${t.network.signUser(alex)}` } });
        op.send({ type: 'join', robot_id: robot.id });
        await op.waitFor((m) => m.type === 'joined');
        const started = Date.now();
        op.send({ type: 'command', id: 'big', kind: 'ptz', value: { pan: 0.5 } });
        const res = await op.waitFor((m) => m.type === 'command_result' && m.id === 'big', 5000);
        assert.ok(res, 'the command was answered, not left pending');
        assert.strictEqual(res.result, 'nack');
        assert.ok(Date.now() - started < 4000, 'the oversized reply was cut off well before the request timeout');
        op.close();
    });

    await check('a move with no finite deadline_ms is still followed by a Stop at the robot maxCommandMs', async () => {
        const sent = [];
        const u = unitOnvif({ fetchImpl: async (url, opts) => { sent.push(opts.body); return new Response(okXml, { status: 200 }); } });
        await u.onvif.attach(u.robot, u.profile);
        const link = u.links.get(`dev_onvif_${ROB}`);
        link.onFrame({ type: 'command', id: 'm1', kind: 'ptz', value: { pan: 0.5 } });   // no deadline_ms
        assert.ok(await poll(() => sent.some((b) => b.includes('<tptz:ContinuousMove>')), 1000), 'the move was sent');
        assert.ok(await poll(() => sent.some((b) => b.includes('<tptz:Stop>')), 1500), 'a continuous move is never left running');
        u.onvif.stopAll();
    });

    await check('a failed Stop is retried once, and a double failure logs the robot id alone', async () => {
        // First Stop fails, the retry succeeds: two attempts, nothing logged.
        const warns = [];
        let stops = 0;
        const retried = unitOnvif({
            log: { warn: (...a) => warns.push(a.join(' ')) },
            fetchImpl: async (url, opts) => {
                if (opts.body.includes('<tptz:Stop>') && ++stops === 1) throw new Error('network down');
                return new Response(okXml, { status: 200 });
            },
        });
        await retried.onvif.attach(retried.robot, retried.profile);
        retried.links.get(`dev_onvif_${ROB}`).onFrame({ type: 'command', id: 'h1', kind: 'halt', value: {} });
        assert.ok(await poll(() => stops >= 2, 1500), `the failed Stop was retried (${stops})`);
        assert.ok(!warns.some((w) => w.includes('stop failed')), 'a Stop that succeeds on retry is not logged');
        retried.onvif.stopAll();

        // Both attempts fail: warn once, with the robot id and nothing else.
        const failedWarns = [];
        const failed = unitOnvif({
            log: { warn: (...a) => failedWarns.push(a.join(' ')) },
            fetchImpl: async (url, opts) => {
                if (opts.body.includes('<tptz:Stop>')) throw new Error(`cannot reach ${url}`);
                return new Response(okXml, { status: 200 });
            },
        });
        await failed.onvif.attach(failed.robot, failed.profile);
        failed.links.get(`dev_onvif_${ROB}`).onFrame({ type: 'command', id: 'h2', kind: 'halt', value: {} });
        assert.ok(await poll(() => failedWarns.some((w) => w.includes('stop failed')), 1500), 'the double failure was logged');
        const line = failedWarns.find((w) => w.includes('stop failed'));
        assert.ok(line.includes(ROB), 'the log names the robot');
        assert.ok(!line.includes(failed.camera.url) && !line.includes('#PasswordDigest'), 'the log carries no URL or credentials');
        failed.onvif.stopAll();
    });

    await check('a camera whose clock is 5 minutes ahead gets a Created matched to its clock', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'camera.onvif' });
        assert.strictEqual(await t.app.locals.onvif.attach(plot(robot.id, skewed.url)), true);
        assert.ok(await poll(() => skewed.calls.some((c) => c.body.includes('GetSystemDateAndTime')), 2000), 'the clock was read');
        const other = skewed.calls.find((c) => c.body.includes('GetStatus'));
        assert.ok(other, 'a GetStatus followed the clock sync');
        const before = skewed.calls.length;
        const op = await t.ws('/control', { headers: { Authorization: `Bearer ${t.network.signUser(alex)}` } });
        op.send({ type: 'join', robot_id: robot.id });
        await op.waitFor((m) => m.type === 'joined');
        op.send({ type: 'command', id: 'skew1', kind: 'ptz', value: { pan: 0.5 } });
        const res = await op.waitFor((m) => m.type === 'command_result' && m.id === 'skew1');
        assert.strictEqual(res.result, 'ack');
        const move = skewed.calls.slice(before).find((c) => c.body.includes('ContinuousMove'));
        assert.ok(move, 'the move reached the skewed camera');
        const created = /<wsu:Created>([^<]+)<\/wsu:Created>/.exec(move.body);
        assert.ok(created, 'the move carries a WS-Security Created');
        const delta = new Date(created[1]).getTime() - Date.now();
        assert.ok(Math.abs(delta - 5 * 60 * 1000) < 5000, `Created tracks the camera clock, not the local one (delta ${delta} ms)`);
        op.close();
    });

    await t.close();
    await skewed.close();
    await huge.close();
    delete process.env.CAM_USER;
    delete process.env.CAM_PASS;
    done();
})();
