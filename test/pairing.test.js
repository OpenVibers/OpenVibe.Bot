'use strict';
// Pairing and credentials (ADR-043 decisions 1–2, acceptance tests): one use, expiry, 5 tries, never
// logged or returned by a read, rotation with a 60 s grace, revocation that disconnects at once.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
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

    await t.close();
    done();
})();
