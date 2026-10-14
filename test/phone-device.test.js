'use strict';
// A phone as the robot's device (plan T15 "an Android phone as the robot's brain", profile driver `phone`): the
// pairing page shows a QR code that opens /device/phone with the code, the phone pairs over POST /api/v1/pair, and its
// browser offers the credential as a subprotocol on /device (a browser cannot set Authorization).
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { loadProfiles } = require('../server/profiles');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const get = (p, user) => fetch(t.base + p, { redirect: 'manual', headers: user ? cookie(user) : {} });

    await check('phone.camera ships: camera, voice, a face, torch, chime, tilt and battery, driver phone', () => {
        const p = loadProfiles().get('phone.camera');
        assert.strictEqual(p.mapping.driver, 'phone');
        assert.deepStrictEqual(Object.keys(p.commands).sort(), ['actuator', 'display', 'halt', 'say']);
        assert.deepStrictEqual(p.widgets.map((w) => w.type), ['camera', 'speaker', 'display', 'lights', 'horn', 'telemetry', 'battery', 'latency']);
    });

    await check('GET /device/phone: public, its own CSP (the WHIP ingest only), camera allowed, the client script', async () => {
        const r = await get('/device/phone');
        assert.strictEqual(r.status, 200);
        const csp = r.headers.get('content-security-policy');
        assert.match(csp, /connect-src 'self'[^;]*https:\/\/cloudflareinsights\.com/);
        assert.doesNotMatch(csp, /esm\.sh|unsafe-inline/);
        assert.match(r.headers.get('permissions-policy'), /camera=\(self\)/);
        const html = await r.text();
        assert.ok(html.includes('<script src="/panel/phone-device.js" defer></script>') && html.includes('data-pair-form') && html.includes('data-local-stop'));
        assert.doesNotMatch(html, /<script>|style="/, 'nothing inline');
        assert.strictEqual((await get('/panel/phone-device.js')).status, 200);
    });

    let robot; let pairing;
    await check('a phone robot\'s pairing page is a QR code to /device/phone with the code in the fragment, no installer', async () => {
        ({ robot, pairing } = await t.robot(alex, { name: 'Pocket bot', profile_id: 'phone.camera' }));
        const html = await (await fetch(`${t.base}/pair/${robot.id}`, { headers: { ...cookie(alex), 'Sec-Fetch-Site': 'same-origin' } })).text();
        assert.ok(html.includes('<svg class="qr"') && html.includes('Scan this with the phone'));
        assert.ok(!html.includes('data-copy-source'), 'no command to paste');
        const fresh = /class="code">([^<]+)</.exec(html)[1];
        pairing = { code: fresh };
        assert.ok(html.includes(robot.id));
    });

    let credential;
    await check('the phone pairs over HTTP and connects with its credential as a subprotocol: hello, config, online', async () => {
        const r = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code, agent_version: 'openvibe-phone/1', drivers: ['phone'], name: 'Pixel (browser)' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.profile.id, 'phone.camera');
        credential = r.json.credential;
        assert.match(credential, /^[A-Za-z0-9_-]{43}$/);
        const d = await t.ws('/device', { protocols: ['ov.device', `ov.device.${credential}`] });
        assert.strictEqual(d.ws.protocol, 'ov.device', 'the server answers the offered protocol (a browser drops the socket otherwise)');
        assert.ok(await d.waitFor((m) => m.type === 'hello'));
        const config = await d.waitFor((m) => m.type === 'config');
        assert.ok(config.allowed_commands.includes('say') && config.allowed_commands.includes('display'));
        d.send({ v: 1, type: 'status', firmware: 'openvibe-phone/1', capabilities: {}, faults: [], estop_latched: false });
        d.send({ v: 1, type: 'telemetry', battery: { percent: 81 }, sensors: { tilt: { pitch: 4, roll: -2 } } });
        const c = await t.ws('/control', { headers: cookie(alex) });
        c.send({ type: 'join', robot_id: robot.id });
        const joined = await c.waitFor((m) => m.type === 'joined');
        assert.ok(joined.state.online, 'the phone is the robot\'s device');
        c.send({ type: 'command', id: 's1', kind: 'say', value: { text: 'Hello from the panel' } });
        const cmd = await d.waitFor((m) => m.type === 'command' && m.kind === 'say');
        assert.deepStrictEqual(cmd.value, { text: 'Hello from the panel' });
        d.send({ v: 1, type: 'ack', id: cmd.id });
        assert.strictEqual((await c.waitFor((m) => m.type === 'command_result' && m.id === 's1')).result, 'ack');
        c.send({ type: 'command', id: 'f1', kind: 'display', value: { face: 'happy' } });
        assert.deepStrictEqual((await d.waitFor((m) => m.type === 'command' && m.kind === 'display')).value, { face: 'happy' });
        c.close(); d.close();
    });

    await check('a wrong credential as a subprotocol closes 4002; a malformed one is never read as a credential', async () => {
        const bad = await t.ws('/device', { protocols: ['ov.device', `ov.device.${'A'.repeat(43)}`] });
        assert.strictEqual(await bad.waitForClose(), 4002);
        // Not credential-shaped: the socket stays unpaired (it may only pair), it is not closed as a bad credential.
        const odd = await t.ws('/device', { protocols: ['ov.device', 'ov.device.short'] });
        odd.send({ v: 1, type: 'heartbeat', t: Date.now() });
        assert.strictEqual((await odd.waitFor((m) => m.type === 'error')).code, 'bot.not_paired');
        odd.close();
    });

    await check('the phone model is in the directory, grouped as a phone, and offered when adding a robot', async () => {
        const models = await (await get('/models')).text();
        assert.ok(models.includes('>Phone</h2>') && models.includes('href="/models/phone.camera"'));
        const add = await (await get('/robots/new?profile=phone.camera', alex)).text();
        assert.match(add, /value="phone\.camera" checked/);
        assert.ok(add.includes('A phone, from its browser'));
    });

    await t.close();
    done();
})();
