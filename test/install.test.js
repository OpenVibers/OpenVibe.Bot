'use strict';
// GET /install (plan T15 step 1): a 302 to OpenVibe.Node's installer script, chosen by config only and checked at
// boot (https, allow-listed host). The pairing's installer command carries `--driver <kind>` from the profile,
// and nothing for a profile whose driver is `none`.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { loadConfig } = require('../server/config');
const { driverForProfile } = require('../server/domain');

(async () => {
    const NODE_INSTALLER = 'https://raw.githubusercontent.com/OpenVibers/OpenVibe.Node/main/install/install.sh';

    await check('BOT_INSTALLER_SOURCE_URL: Node\'s script by default, https on an allow-listed host or no boot', async () => {
        assert.strictEqual(loadConfig({}).installer.sourceUrl, NODE_INSTALLER);
        const release = 'https://github.com/OpenVibers/OpenVibe.Node/releases/latest/download/install.sh';
        assert.strictEqual(loadConfig({ BOT_INSTALLER_SOURCE_URL: release }).installer.sourceUrl, release);
        for (const bad of ['http://raw.githubusercontent.com/OpenVibers/OpenVibe.Node/main/install/install.sh', 'https://evil.test/install.sh',
            'https://raw.githubusercontent.com.evil.test/x.sh', 'javascript:alert(1)', 'not a url']) {
            assert.throws(() => loadConfig({ BOT_INSTALLER_SOURCE_URL: bad }), /BOT_INSTALLER_SOURCE_URL must be an https URL on raw\.githubusercontent\.com/, bad);
        }
    });

    await check('driverForProfile: adeept, adeept-mecanum, cozmo, else none', async () => {
        assert.strictEqual(driverForProfile('adeept.adr036'), 'adeept');
        assert.strictEqual(driverForProfile('adeept.adr036.mecanum'), 'adeept-mecanum');
        assert.strictEqual(driverForProfile('cozmo'), 'cozmo');
        for (const id of ['sim.rover', 'camera.onvif', 'toString', undefined]) assert.strictEqual(driverForProfile(id), 'none', String(id));
    });

    const source = 'https://github.com/OpenVibers/OpenVibe.Node/releases/download/v1.2.3/install.sh';
    const t = await boot({ env: { BOT_INSTALLER_SOURCE_URL: source } });
    const alex = t.network.newUser('alex');

    await check('GET /install → 302 to the configured source; no query parameter changes the target', async () => {
        for (const q of ['', '?url=https://evil.test/x.sh', '?to=https://evil.test/x.sh', '?url=//evil.test&to=/x&next=https://evil.test']) {
            const res = await fetch(`${t.base}/install${q}`, { redirect: 'manual' });
            assert.strictEqual(res.status, 302, q);
            assert.strictEqual(res.headers.get('location'), source, q);
        }
    });

    await check('the installer command ends with --driver for an adeept, mecanum or cozmo robot, and has none for sim.rover', async () => {
        for (const [profile_id, driver] of [['adeept.adr036', 'adeept'], ['adeept.adr036.mecanum', 'adeept-mecanum'], ['cozmo', 'cozmo']]) {
            const { robot, pairing } = await t.robot(alex, { profile_id });
            assert.strictEqual(pairing.installer, `curl -fsSL https://openvibe.bot/install | sh -s -- --robot ${robot.id} --code ${pairing.code} --driver ${driver}`);
            const again = await t.call('POST', `/api/v1/robots/${robot.id}/pairing-code`, { user: alex });
            assert.strictEqual(again.status, 201, again.text);
            assert.match(again.json.installer, new RegExp(`--robot ${robot.id} --code ${again.json.code} --driver ${driver}$`));
        }
        const { robot, pairing } = await t.robot(alex, { profile_id: 'sim.rover' });
        assert.strictEqual(pairing.installer, `curl -fsSL https://openvibe.bot/install | sh -s -- --robot ${robot.id} --code ${pairing.code}`);
    });
    await t.close();

    const n = await boot({ env: { BOT_PAIRING_AUTHORITY: 'network' } });
    await check('network authority: the Network form gains --driver too, on create and on a new code', async () => {
        const sam = n.network.newUser('sam');
        const { robot, pairing } = await n.robot(sam, { profile_id: 'cozmo' });
        const asked = n.network.pairings.at(-1);
        assert.strictEqual(pairing.installer, `curl -fsSL https://openvibe.bot/install | sh -s -- --network ${n.network.url} --pairing ${asked.pairing_id} --code ${asked.code} --driver cozmo`);
        const again = await n.call('POST', `/api/v1/robots/${robot.id}/pairing-code`, { user: sam });
        assert.strictEqual(again.status, 201, again.text);
        assert.match(again.json.installer, / --code \S+ --driver cozmo$/);
    });
    await n.close();
    done();
})();
