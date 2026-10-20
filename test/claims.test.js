'use strict';
// A device that asks to be added (server/claims.js): the installer run with no code starts a claim, the owner approves
// it on /link, the device collects the pairing of the robot that made and pairs the usual way, and what the owner chose
// (its video on their Live channel) is turned on once it has paired. Owner, 2026-10-17: "I should be able to run a
// single command on my raspi … ready to go live and controllable".
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const get = (p, user) => fetch(t.base + p, { redirect: 'manual', headers: user ? cookie(user) : {} });
    const post = (p, user, body, headers = {}) => fetch(t.base + p, {
        method: 'POST', redirect: 'manual', body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(user ? cookie(user) : {}), ...headers },
    });
    const start = (body) => t.call('POST', '/api/v1/claims', { token: null, body });
    const poll = (c, secret = c.secret) => t.call('GET', `/api/v1/claims/${c.id}`, { token: null, headers: { 'X-OV-Claim-Secret': secret } });
    const streamOf = (robotId) => [...t.openre.streams.values()].find((s) => s.refs.some((r) => r.type === 'robot' && r.id === robotId));
    // What OpenVibe.Node's installer sends after looking at an Adeept ADR036 on a Pi 4.
    const pi = {
        hostname: 'raspi',
        hardware: { model: 'Raspberry Pi 4 Model B Rev 1.4', os: 'Debian GNU/Linux 12 (bookworm)', arch: 'aarch64', kit: 'adeept.adr036',
            kit_name: 'Adeept ADR036 4WD', found: ['PCA9685 at 0x5f', 'ADS7830 at 0x48'], camera: 'imx219', password: 'hunter2' },
    };
    let claim, robotId;

    await check('a device starts a claim with no token: a code, a secret, and where to enter the code', async () => {
        const r = await start(pi);
        assert.strictEqual(r.status, 201, r.text);
        claim = r.json;
        assert.match(claim.id, /^clm_[0-9A-Z]{26}$/);
        assert.match(claim.user_code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
        assert.ok(claim.secret.length >= 40 && claim.interval >= 1);
        assert.strictEqual(claim.verification_url_complete, `${t.config.baseUrl}/link?code=${claim.user_code}`);
        const row = await t.db.maybe('SELECT * FROM device_claims WHERE id = $1', [claim.id]);
        assert.ok(row.user_code_hash !== claim.user_code && row.secret_hash !== claim.secret, 'only hashes are kept');
        assert.ok(!('password' in row.hardware), 'only the fields the page shows are kept');
        assert.strictEqual(row.suggested_profile, 'adeept.adr036');
    });

    await check('polling: the right secret sees pending, a wrong one the same 404 as no claim at all', async () => {
        assert.strictEqual((await poll(claim)).json.state, 'pending');
        assert.strictEqual((await poll(claim, 'nope')).status, 404);
        assert.strictEqual((await poll({ id: 'clm_01JZ00000000000000000000AA', secret: claim.secret })).status, 404);
    });

    await check('/link: sign in first, then the device, what it found, and its choices', async () => {
        const out = await get(`/link?code=${claim.user_code}`);
        assert.strictEqual(out.status, 302);
        assert.match(out.headers.get('location'), /^\/auth\/login\?next=%2Flink%3Fcode%3D/);
        const r = await get(`/link?code=${claim.user_code.toLowerCase().replace('-', ' ')}`, alex);
        assert.strictEqual(r.status, 200);
        const html = await r.text();
        assert.ok(html.includes('Add raspi?') && html.includes('PCA9685 at 0x5f, ADS7830 at 0x48') && html.includes('imx219'));
        assert.match(html, /<option value="adeept\.adr036" selected>[^<]*\(found on it\)<\/option>/);
        assert.ok(html.includes('value="adeept.adr036.mecanum"'), 'the mecanum chassis looks the same on the bus: the owner picks it');
        assert.ok(!html.includes('value="sim.rover"') && !html.includes('value="camera.onvif"'), 'only what a device can be');
        assert.match(html, /name="live" value="on" checked/);
        assert.ok(html.includes(`action="/link/${claim.id}/approve"`) && html.includes(`action="/link/${claim.id}/deny"`));
        const wrong = await get('/link?code=ZZZZ-ZZZZ', alex);
        assert.strictEqual(wrong.status, 404);
        assert.ok((await wrong.text()).includes('No device is waiting with that code'));
        assert.ok((await (await get('/link', alex)).text()).includes(`curl -fsSL ${t.config.installer.scriptUrl} | sh`));
    });

    await check('what a device reports is shown escaped and its hostname cut to a hostname', async () => {
        const evil = (await start({ hostname: '<b>pi</b>', hardware: { found: ['<img src=x onerror=alert(1)>'], kit: 'local.rob_x' } })).json;
        const html = await (await get(`/link?code=${evil.user_code}`, alex)).text();
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;') && !html.includes('<img src=x'));
        assert.ok(html.includes('Add bpib?'), 'a hostname keeps only hostname characters');
        assert.strictEqual((await t.db.maybe('SELECT suggested_profile FROM device_claims WHERE id = $1', [evil.id])).suggested_profile, null);
    });

    await check('approving: same-site only and a listed model; then the robot is the approver\'s', async () => {
        const form = 'name=Garage+rover&profile_id=adeept.adr036&access_policy=private&live=on';
        assert.strictEqual((await post(`/link/${claim.id}/approve`, alex, form, { Origin: 'https://evil.test' })).status, 403);
        const bad = await post(`/link/${claim.id}/approve`, alex, form.replace('adeept.adr036', 'sim.rover'));
        assert.strictEqual(bad.status, 422);
        assert.ok((await bad.text()).includes('choose one of the models listed'));
        const ok = await post(`/link/${claim.id}/approve`, alex, form);
        assert.strictEqual(ok.status, 201);
        const html = await ok.text();
        const robot = (await t.domain.robots.list(alex.subject))[0];
        robotId = robot.id;
        assert.deepStrictEqual([robot.name, robot.profile_id, robot.access_policy], ['Garage rover', 'adeept.adr036', 'private']);
        assert.ok(html.includes(`data-pair-robot="${robotId}"`) && html.includes('On your Live channel'));
        assert.ok(html.includes(`href="https://openvibe.live/@alex?bind_robot=${robotId}"`), 'and the way to drive it from their chat');
        assert.strictEqual((await post(`/link/${claim.id}/approve`, alex, form)).status, 404, 'a claim is approved once');
        assert.strictEqual((await get(`/link?code=${claim.user_code}`, alex)).status, 404, 'and its code is spent');
    });

    await check('the device collects the pairing, pairs the usual way, and only then goes on Live', async () => {
        const r = await poll(claim);
        assert.strictEqual(r.json.state, 'approved');
        assert.deepStrictEqual([r.json.robot_id, r.json.driver, r.json.profile_id, r.json.name], [robotId, 'adeept', 'adeept.adr036', 'Garage rover']);
        assert.strictEqual(r.json.pairing.robot, robotId);
        assert.match(r.json.pairing.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
        assert.strictEqual(r.json.panel_url, `${t.config.baseUrl}/panel/${robotId}`);
        assert.strictEqual(r.json.live, true, 'the device can say where it shows');
        assert.strictEqual((await poll(claim)).json.pairing.code, r.json.pairing.code, 'the device may ask again until it has paired');
        const paired = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robotId, code: r.json.pairing.code, device_kind: 'onboard', name: 'raspi' } });
        assert.strictEqual(paired.status, 201, paired.text);
        assert.strictEqual(streamOf(robotId).mirror_to_live, true, 'the owner asked for its video on their channel');
        const row = await t.db.maybe('SELECT state, pairing, live_applied_at FROM device_claims WHERE id = $1', [claim.id]);
        assert.deepStrictEqual([row.state, row.pairing], ['paired', null], 'the pairing is gone once used');
        assert.ok(row.live_applied_at);
        assert.deepStrictEqual((await poll(claim)).json, { state: 'paired', robot_id: robotId });
    });

    await check('without the Live box the stream stays off Live', async () => {
        const c = (await start({ hostname: 'shy', hardware: {} })).json;
        assert.strictEqual((await post(`/link/${c.id}/approve`, alex, 'name=Shy&profile_id=relay.generic&access_policy=private')).status, 201);
        const p = (await poll(c)).json;
        assert.strictEqual(p.driver, 'none');
        assert.strictEqual((await t.call('POST', '/api/v1/pair', { token: null, body: { robot: p.robot_id, code: p.pairing.code } })).status, 201);
        assert.strictEqual(streamOf(p.robot_id).mirror_to_live, false);
    });

    await check('denying: the device is told no and nothing is made', async () => {
        const c = (await start({ hostname: 'stranger' })).json;
        assert.strictEqual((await post(`/link/${c.id}/deny`, bob, '', { Origin: 'https://evil.test' })).status, 403);
        const r = await post(`/link/${c.id}/deny`, bob, '');
        assert.strictEqual(r.status, 200);
        assert.ok((await r.text()).includes('That device was told no'));
        assert.deepStrictEqual((await poll(c)).json, { state: 'denied' });
        assert.strictEqual((await post(`/link/${c.id}/approve`, bob, 'name=x&profile_id=adeept.adr036')).status, 404);
        assert.strictEqual((await t.domain.robots.list(bob.subject)).length, 0);
    });

    await check('a code lasts 15 minutes', async () => {
        const c = (await start({ hostname: 'late' })).json;
        t.clock.offset += 16 * 60 * 1000;
        try {
            assert.strictEqual((await poll(c)).json.state, 'expired');
            assert.strictEqual((await get(`/link?code=${c.user_code}`, alex)).status, 404);
        } finally { t.clock.offset -= 16 * 60 * 1000; }
    });

    await check('starting a claim is counted by address', async () => {
        let last;
        for (let i = 0; i < 8 && (!last || last.status !== 429); i++) last = await start({ hostname: `flood${i}` });
        assert.strictEqual(last.status, 429);
    });

    await t.close();
    done();
})();
