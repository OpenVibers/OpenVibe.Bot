'use strict';
// The server-side ONVIF camera (camera.onvif, server/onvif): an in-process device attached beside the
// simulator, but with a real `kind: 'server'` device row and one outbound ONVIF request per ptz command.
// Against a stub ONVIF endpoint this checks a ptz command becomes a ContinuousMove (with the credentials as a
// WS-Security digest, never in clear) and that telemetry carries the camera's GetStatus readout. The request
// only ever goes to the configured host, with a timeout, and BOT_ONVIF_CAMERAS refuses a URL that would
// carry credentials or a non-http(s) scheme at boot.
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/app');
const { loadConfig } = require('../server/config');

const CAM_USER = 'onvif-operator';
const CAM_PASS = 'sup3r-secret-pass';

/** A stub ONVIF PTZ service: records every request and answers GetStatus with a fixed Position. */
function startCamera() {
    return new Promise((resolve) => {
        const calls = [];
        const status = '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
            + '<s:Body><tptz:GetStatusResponse xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"><tptz:PTZStatus>'
            + '<tt:Position xmlns:tt="http://www.onvif.org/ver10/schema"><tt:PanTilt x="0.25" y="-0.5"/><tt:Zoom x="0.1"/></tt:Position>'
            + '<tt:MoveStatus><tt:PanTilt>IDLE</tt:PanTilt><tt:Zoom>IDLE</tt:Zoom></tt:MoveStatus>'
            + '</tptz:PTZStatus></tptz:GetStatusResponse></s:Body></s:Envelope>';
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (d) => chunks.push(d));
            req.on('end', () => {
                calls.push({ method: req.method, path: req.url, host: req.headers.host, contentType: req.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8') });
                res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
                res.end(status);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/onvif/ptz_service`, calls, close: () => new Promise((r) => server.close(r)) }));
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

(async () => {
    await check('BOT_ONVIF_CAMERAS is validated at boot: a bad URL, scheme or embedded credential refuses', () => {
        const parse = (v) => { try { loadConfig({ BOT_ONVIF_CAMERAS: v }); return null; } catch (e) { return e.message; } };
        assert.match(parse('not json'), /BOT_ONVIF_CAMERAS must be JSON/);
        assert.match(parse('[]'), /must be a JSON object/);
        assert.match(parse(JSON.stringify({ '*': { url: 'ftp://cam/x' } })), /http\(s\)/);
        assert.match(parse(JSON.stringify({ '*': { url: 'http://user:pw@cam/x' } })), /must carry no credentials/);
        assert.match(parse(JSON.stringify({ '*': { url: 'http://cam/x', username_ref: 'U' } })), /both username_ref and password_ref/);
        assert.match(parse(JSON.stringify({ '*': { url: 'http://cam/x', password_ref: 'P' } })), /both username_ref and password_ref/);
        // The ref, not the value, is what config keeps.
        const c = loadConfig({ BOT_ONVIF_CAMERAS: JSON.stringify({ rob_x: { url: 'http://cam/x', username_ref: 'CAM_USER', password_ref: 'CAM_PASS' } }) });
        assert.deepStrictEqual(c.onvif.cameras.rob_x, { url: 'http://cam/x', usernameRef: 'CAM_USER', passwordRef: 'CAM_PASS', profileToken: 'profile_1' });
        assert.strictEqual(JSON.stringify(c).includes(CAM_PASS), false, 'no secret value appears in the config');
    });

    const cam = await startCamera();
    process.env.CAM_USER = CAM_USER;
    process.env.CAM_PASS = CAM_PASS;
    const t = await boot({
        env: {
            BOT_ONVIF_CAMERAS: JSON.stringify({ '*': { url: cam.url, username_ref: 'CAM_USER', password_ref: 'CAM_PASS' } }),
            BOT_ONVIF_TIMEOUT_MS: '1000',
        },
    });
    const alex = t.network.newUser('alex');

    await check('an onvif robot attaches in-process: a kind:server device row, no sim count, GetStatus readout', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'camera.onvif' });
        assert.strictEqual(await t.app.locals.onvif.attach(robot.id), true);
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

    await check('a ptz command becomes an ONVIF ContinuousMove to the configured host, and is acked', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'camera.onvif' });
        assert.strictEqual(await t.app.locals.onvif.attach(robot.id), true);
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
        await t.app.locals.onvif.attach(robot.id);
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
        t.app.locals.onvif.stopAll();
        const n = await t.app.locals.onvif.startAll();
        assert.ok(n >= 1, `startAll attached the onvif robots (${n})`);
        assert.strictEqual(t.app.locals.onvif.running(robot.id), true);
        t.app.locals.onvif.stopAll();
        assert.strictEqual(t.app.locals.onvif.running(robot.id), false);
        assert.strictEqual(t.hub.isOnline(`dev_onvif_${robot.id}`), false);
    });

    await t.close();
    delete process.env.CAM_USER;
    delete process.env.CAM_PASS;
    done();
})();
