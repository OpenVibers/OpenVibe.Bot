'use strict';
// BOT_PAIRING_AUTHORITY (plan T15 B2). bot (the default): Bot mints and stores the pairing code, as before.
// network: POST /robots and POST /robots/:id/pairing-code ask Network (POST /internal/node-pairings) for the
// code and Bot stores none; POST /pair and the `pair` frame answer 410 bot.pairing_moved; Network not
// answering is 503 bot.network_unavailable and creates no robot. An unknown value refuses to boot.
const assert = require('assert');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const codesFor = async (t, robotId) => Number((await t.db.maybe('SELECT count(*) AS n FROM pairing_codes WHERE robot_id = $1', [robotId])).n);

    await check('an unknown BOT_PAIRING_AUTHORITY refuses to boot', async () => {
        const { loadConfig } = require('../server/config');
        assert.throws(() => loadConfig({ BOT_PAIRING_AUTHORITY: 'both' }), /BOT_PAIRING_AUTHORITY must be bot or network, not "both"/);
        assert.strictEqual(loadConfig({}).pairing.authority, 'bot', 'bot is the default');
        assert.strictEqual(loadConfig({ BOT_PAIRING_AUTHORITY: 'network' }).pairing.authority, 'network');
        const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
            cwd: os.tmpdir(), env: { ...process.env, NODE_ENV: 'test', BOT_PAIRING_AUTHORITY: 'Network' }, encoding: 'utf8', timeout: 20000,
        });
        assert.strictEqual(run.status, 1, run.stderr);
        assert.match(run.stderr, /could not start: BOT_PAIRING_AUTHORITY must be bot or network, not "Network"/);
    });

    const bot = await boot();
    await check('bot (the default): the code is minted and stored by Bot, Network is not asked', async () => {
        const alex = bot.network.newUser('alex');
        const { robot, pairing } = await bot.robot(alex);
        assert.match(pairing.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
        assert.match(pairing.installer, new RegExp(`--robot ${robot.id} --code ${pairing.code}$`));
        assert.strictEqual(pairing.pairing_id, undefined);
        assert.strictEqual(await codesFor(bot, robot.id), 1);
        assert.strictEqual(bot.network.pairings.length, 0);
        const paired = await bot.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
        assert.strictEqual(paired.status, 201, paired.text);
    });
    await bot.close();

    const t = await boot({ env: { BOT_PAIRING_AUTHORITY: 'network' } });
    const alex = t.network.newUser('alex');

    await check('network: POST /robots asks Network for the code and stores none', async () => {
        const { robot, pairing } = await t.robot(alex);
        const asked = t.network.pairings.at(-1);
        assert.strictEqual(asked.service, 'bot', "Bot's own svc:bot token with network.node.manage");
        assert.deepStrictEqual(asked.body, { owner: { kind: 'user', subject: alex.subject }, ref: robot.id });
        assert.strictEqual(pairing.code, asked.code);
        assert.strictEqual(pairing.pairing_id, asked.pairing_id);
        assert.strictEqual(pairing.expires_at, asked.expires_at);
        assert.strictEqual(pairing.installer, `curl -fsSL https://openvibe.bot/install | sh -s -- --network ${t.network.url} --pairing ${asked.pairing_id} --code ${asked.code}`);
        assert.strictEqual(await codesFor(t, robot.id), 0);
    });

    await check('network: a new code is minted on Network for the robot\'s owner, also by a service', async () => {
        const { robot } = await t.robot(alex);
        const mine = await t.call('POST', `/api/v1/robots/${robot.id}/pairing-code`, { user: alex });
        assert.strictEqual(mine.status, 201, mine.text);
        assert.strictEqual(mine.json.pairing_id, t.network.pairings.at(-1).pairing_id);
        const svc = await t.call('POST', `/api/v1/robots/${robot.id}/pairing-code`, { cap: ['bot.robot.manage'], headers: { 'X-OV-Subject': alex.subject } });
        assert.strictEqual(svc.status, 201, svc.text);
        assert.deepStrictEqual(t.network.pairings.at(-1).body, { owner: { kind: 'user', subject: alex.subject }, ref: robot.id });
        assert.strictEqual(await codesFor(t, robot.id), 0);
    });

    await check('network: POST /pair and the pair frame answer 410 bot.pairing_moved with the Network URL', async () => {
        const { robot, pairing } = await t.robot(alex);
        const r = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
        assert.strictEqual(r.status, 410, r.text);
        assert.strictEqual(r.json.code, 'bot.pairing_moved');
        assert.ok(r.json.detail.includes(t.network.url), r.text);
        const dev = await t.ws('/device');
        dev.send({ type: 'pair', robot: robot.id, code: pairing.code });
        const err = await dev.waitFor((m) => m.type === 'error');
        assert.strictEqual(err.code, 'bot.pairing_moved');
        assert.ok(err.detail.includes(t.network.url));
        assert.ok(!dev.messages.some((m) => m.type === 'paired'));
        dev.close();
        assert.strictEqual(Number((await t.db.maybe('SELECT count(*) AS n FROM devices')).n), 0, 'no device was made');
    });

    await check('network: Network not answering → 503 bot.network_unavailable, no robot and no local code', async () => {
        const bob = t.network.newUser('bob');
        const { robot } = await t.robot(bob);
        t.network.failPairings(500);
        try {
            const created = await t.call('POST', '/api/v1/robots', { user: bob, body: { name: 'Offline', profile_id: 'sim.rover' } });
            assert.strictEqual(created.status, 503, created.text);
            assert.strictEqual(created.json.code, 'bot.network_unavailable');
            const again = await t.call('POST', `/api/v1/robots/${robot.id}/pairing-code`, { user: bob });
            assert.strictEqual(again.status, 503, again.text);
            assert.strictEqual(again.json.code, 'bot.network_unavailable');
        } finally { t.network.failPairings(null); }
        const robots = await t.call('GET', '/api/v1/robots', { user: bob });
        assert.deepStrictEqual(robots.json.robots.map((x) => x.id), [robot.id], 'the refused POST /robots left no robot');
        assert.strictEqual(await codesFor(t, robot.id), 0);
    });

    await check('network: a machine paired on Network still binds (dual-accept)', async () => {
        const { robot } = await t.robot(alex);
        const bind = await t.call('POST', '/api/v1/devices/bind', { token: t.network.signNode(t.network.addNode({ owner: alex.subject, ref: robot.id })) });
        assert.strictEqual(bind.status, 201, bind.text);
    });

    await t.close();
    done();
})();
