'use strict';
// Pairing and credentials (ADR-043 decisions 1–2, acceptance tests): one use, expiry, 5 tries, never
// logged or returned by a read, rotation with a 60 s grace, revocation that disconnects at once.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

const WHIP_BASE = 'https://whip.test/ingest';

(async () => {
    const t = await boot({ env: { BOT_WHIP_BASE: WHIP_BASE } });
    const alex = t.network.newUser('alex');

    const redeem = (body) => t.call('POST', '/api/v1/pair', { token: null, body });

    await check('a pairing code works exactly once', async () => {
        const { robot, pairing } = await t.robot(alex);
        const first = await redeem({ robot: robot.id, code: pairing.code, agent_version: '0.1.0', device_kind: 'onboard', drivers: ['pca9685'] });
        assert.strictEqual(first.status, 201, first.text);
        assert.match(first.json.device_id, /^dev_/);
        assert.ok(first.json.credential && first.json.credential.length >= 40);
        assert.ok(first.json.publish_key && first.json.publish_key.length >= 40);
        assert.strictEqual(first.json.profile.id, 'sim.rover');
        assert.strictEqual(first.json.whip_url, `${WHIP_BASE}/${first.json.publish_key}`, 'video bootstraps from the publish key');
        const again = await redeem({ robot: robot.id, code: pairing.code });
        assert.strictEqual(again.status, 403);
        assert.strictEqual(again.json.code, 'bot.pairing_code_used');
    });

    await check('a pairing code expires after 10 minutes', async () => {
        const { robot, pairing } = await t.robot(alex);
        t.clock.offset += 10 * 60 * 1000 + 1000;
        const late = await redeem({ robot: robot.id, code: pairing.code });
        assert.strictEqual(late.status, 403);
        assert.strictEqual(late.json.code, 'bot.pairing_code_expired');
        t.clock.offset -= 10 * 60 * 1000 + 1000;
    });

    await check('five wrong tries end the code', async () => {
        const { robot, pairing } = await t.robot(alex);
        for (let i = 1; i <= 5; i++) {
            const bad = await redeem({ robot: robot.id, code: 'AAAA-AAAA' });
            assert.strictEqual(bad.status, 403, `try ${i}`);
            assert.strictEqual(bad.json.code, i < 5 ? 'bot.pairing_code_invalid' : 'bot.pairing_code_locked', `try ${i}`);
        }
        const correct = await redeem({ robot: robot.id, code: pairing.code });
        assert.strictEqual(correct.status, 403);
        assert.ok(['bot.pairing_code_locked', 'bot.pairing_code_used'].includes(correct.json.code));
    });

    await check('the credential and publish key are never logged and never in a read answer', async () => {
        const { robot, pairing } = await t.robot(alex);
        const paired = await redeem({ robot: robot.id, code: pairing.code });
        const { credential, publish_key: publishKey } = paired.json;
        const paths = ['/api/health', '/api/ready', '/release.json', '/api/v1/profiles', '/api/v1/robots', `/api/v1/robots/${robot.id}`,
            `/api/v1/robots/${robot.id}/devices`, `/api/v1/robots/${robot.id}/operators`, `/api/v1/robots/${robot.id}/audit`];
        for (const p of paths) {
            const r = await t.call('GET', p, { user: alex });
            assert.ok(!r.text.includes(credential), `${p} leaked the credential`);
            assert.ok(!r.text.includes(publishKey), `${p} leaked the publish key`);
        }
        const logged = t.logs.join('\n');
        assert.ok(!logged.includes(credential), 'the credential was logged');
        assert.ok(!logged.includes(publishKey), 'the publish key was logged');
        assert.ok(!logged.includes(pairing.code.replace('-', '')), 'the pairing code was logged');
        const devices = await t.call('GET', `/api/v1/robots/${robot.id}/devices`, { user: alex });
        assert.ok(!JSON.stringify(devices.json).includes('hash'), 'device read exposed a hash');
    });

    await check('rotation keeps the old credential 60 s; revocation is instant and disconnects', async () => {
        const { robot, pairing } = await t.robot(alex);
        const paired = await redeem({ robot: robot.id, code: pairing.code });
        const deviceId = paired.json.device_id;
        assert.ok(await t.domain.devices.byCredential(paired.json.credential), 'the credential authenticates');
        const rot = await t.call('POST', `/api/v1/devices/${deviceId}/rotate`, { user: alex });
        assert.strictEqual(rot.status, 200, rot.text);
        assert.ok(await t.domain.devices.byCredential(rot.json.credential), 'the new credential authenticates');
        assert.strictEqual(rot.json.whip_url, `${WHIP_BASE}/${rot.json.publish_key}`, 'the new publish key brings its WHIP URL');
        assert.ok(!rot.text.includes(paired.json.publish_key), 'the old publish key is not returned');
        assert.ok(!rot.text.includes(paired.json.whip_url), 'the old WHIP URL is no longer returned');
        assert.ok(await t.domain.devices.byCredential(paired.json.credential), 'the old credential still works inside the 60 s grace');
        t.clock.offset += 61 * 1000;
        assert.strictEqual(await t.domain.devices.byCredential(paired.json.credential), null, 'the old credential is dead after 60 s');
        t.clock.offset -= 61 * 1000;

        const dev = await t.ws('/device', { headers: { Authorization: `Bearer ${rot.json.credential}` } });
        await dev.waitFor((m) => m.type === 'hello');
        await t.call('POST', `/api/v1/devices/${deviceId}/revoke`, { user: alex });
        assert.strictEqual(await dev.waitForClose(), 4003, 'revocation closes the socket');
        assert.strictEqual(await t.domain.devices.byCredential(rot.json.credential), null, 'the credential is dead');
    });

    await check('a trailing slash on BOT_WHIP_BASE is trimmed for the pair answer and the paired frame', async () => {
        const t2 = await boot({ env: { BOT_WHIP_BASE: `${WHIP_BASE}/` } });
        try {
            const alex2 = t2.network.newUser('alex');
            const { robot, pairing } = await t2.robot(alex2);
            const http = await t2.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
            assert.strictEqual(http.status, 201, http.text);
            assert.strictEqual(http.json.whip_url, `${WHIP_BASE}/${http.json.publish_key}`, 'POST /pair trims the base');
            const second = await t2.robot(alex2);
            const dev = await t2.ws('/device');
            dev.send({ type: 'pair', robot: second.robot.id, code: second.pairing.code });
            const paired = await dev.waitFor((m) => m.type === 'paired');
            assert.strictEqual(paired.whip_url, `${WHIP_BASE}/${paired.publish_key}`, 'the paired frame trims the base');
            dev.close();
        } finally { await t2.close(); }
    });

    await check('with BOT_WHIP_BASE unset the pair answer and the paired frame have no whip_url key', async () => {
        const t3 = await boot();
        try {
            const alex3 = t3.network.newUser('alex');
            const { robot, pairing } = await t3.robot(alex3);
            const http = await t3.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
            assert.strictEqual(http.status, 201, http.text);
            assert.ok(!('whip_url' in http.json), `POST /pair carried a whip_url: ${http.text}`);
            assert.ok(!http.text.includes('"whip_url"'), 'the pair answer has no whip_url field');
            const second = await t3.robot(alex3);
            const dev = await t3.ws('/device');
            dev.send({ type: 'pair', robot: second.robot.id, code: second.pairing.code });
            const paired = await dev.waitFor((m) => m.type === 'paired');
            assert.ok(!('whip_url' in paired), 'the paired frame carried a whip_url');
            assert.ok(!JSON.stringify(paired).includes('"whip_url"'), 'the paired frame has no whip_url field');
            dev.close();
        } finally { await t3.close(); }
    });

    await check('reads and robot_state carry neither the publish key nor a WHIP URL', async () => {
        const { robot, pairing } = await t.robot(alex);
        const dev = await t.ws('/device');
        dev.send({ type: 'pair', robot: robot.id, code: pairing.code });
        const paired = await dev.waitFor((m) => m.type === 'paired');
        assert.strictEqual(paired.whip_url, `${WHIP_BASE}/${paired.publish_key}`, 'a set base reaches the device once');
        const paths = ['/api/v1/robots', `/api/v1/robots/${robot.id}`, `/api/v1/robots/${robot.id}/devices`,
            `/api/v1/robots/${robot.id}/operators`, `/api/v1/robots/${robot.id}/audit`];
        for (const p of paths) {
            const r = await t.call('GET', p, { user: alex });
            assert.ok(!r.text.includes(paired.publish_key), `${p} leaked the publish key`);
            assert.ok(!r.text.includes('whip'), `${p} mentioned a WHIP URL`);
        }
        const op = await t.ws('/control', { headers: { Authorization: `Bearer ${t.network.signUser(alex)}` } });
        op.send({ type: 'join', robot_id: robot.id });
        await op.waitFor((m) => m.type === 'joined');
        dev.send({ type: 'status', firmware: 'test' });
        const frame = await op.waitFor((m) => m.type === 'robot_state' && m.state && m.state.online);
        assert.ok(frame, 'a robot_state frame arrived');
        const serialized = JSON.stringify(frame);
        assert.ok(!serialized.includes(paired.publish_key), 'robot_state leaked the publish key');
        assert.ok(!serialized.includes('whip'), 'robot_state mentioned a WHIP URL');
        op.close();
        dev.close();
    });

    await t.close();
    done();
})();
