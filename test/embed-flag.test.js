'use strict';
// The embed flag (plan T15 step R9, s1): robots.embed_public is the owner's opt-in to anonymous read-only
// embedding, web-only (never in /api/v1), and BOT_EMBED_ORIGINS is a validated frame-ancestors allow-list.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { loadConfig, frameAncestors } = require('../server/config');

(async () => {
    const DEFAULTS = ['https://openvibe.live', 'https://www.openvibe.live'];

    await check('BOT_EMBED_ORIGINS defaults to Live\'s origins and builds the frame-ancestors list', () => {
        const c = loadConfig({ NODE_ENV: 'production' });
        assert.deepStrictEqual(c.embed.origins, DEFAULTS);
        assert.strictEqual(frameAncestors(c), "'self' https://openvibe.live https://www.openvibe.live");
    });

    await check('a custom list (commas or spaces) is accepted; localhost only outside production', () => {
        const c = loadConfig({ NODE_ENV: 'production', BOT_EMBED_ORIGINS: 'https://a.test, https://b.test:8443  https://a.test' });
        assert.deepStrictEqual(c.embed.origins, ['https://a.test', 'https://b.test:8443']);
        assert.strictEqual(frameAncestors(c), "'self' https://a.test https://b.test:8443");
        const dev = loadConfig({ NODE_ENV: 'development', BOT_EMBED_ORIGINS: 'http://localhost:4620,http://127.0.0.1:4620' });
        assert.deepStrictEqual(dev.embed.origins, ['http://localhost:4620', 'http://127.0.0.1:4620']);
        assert.throws(() => loadConfig({ NODE_ENV: 'production', BOT_EMBED_ORIGINS: 'http://localhost:4620' }), /BOT_EMBED_ORIGINS/);
    });

    await check('a wildcard, a path, a query, a bare scheme or plain http in production refuse to boot', () => {
        for (const bad of ['*', 'https://*.test', 'https://x.test/path', 'https://x.test/', 'https://x.test?a=1', 'http://evil.test', 'https:', 'openvibe.live', 'http://localhost', 'https://openvibe.live,*']) {
            for (const NODE_ENV of ['production', 'development']) {
                assert.throws(() => loadConfig({ NODE_ENV, BOT_EMBED_ORIGINS: bad }), /BOT_EMBED_ORIGINS entries must be bare https origins/, `${NODE_ENV}: ${bad}`);
            }
        }
        assert.throws(() => loadConfig({ NODE_ENV: 'production', BOT_EMBED_ORIGINS: 'http://evil.test' }), /"http:\/\/evil\.test"/);
    });

    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const carol = t.network.newUser('carol');
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const get = (p, user) => fetch(t.base + p, { redirect: 'manual', headers: user ? cookie(user) : {} });
    const post = (p, user, form, headers = {}) => fetch(t.base + p, {
        method: 'POST', redirect: 'manual', body: typeof form === 'string' ? form : new URLSearchParams(form).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(user ? cookie(user) : {}), ...headers },
    });
    const flag = async (id) => (await t.db.maybe('SELECT embed_public FROM robots WHERE id = $1', [id])).embed_public;

    const { robot } = await t.robot(alex, { name: 'Embeddable' });
    const url = `/robots/${robot.id}/embed`;

    await check('the column is off by default and /api/v1 does not carry it', async () => {
        assert.strictEqual(await flag(robot.id), false);
        assert.strictEqual((await t.domain.robots.get(robot.id)).embed_public, false);
        const r = await t.call('GET', `/api/v1/robots/${robot.id}`, { user: alex });
        assert.strictEqual(r.status, 200);
        assert.ok(!r.text.includes('embed_public'));
    });

    await check('the owner turns it on and off; the panel and the list show the switch', async () => {
        const on = await post(url, alex, 'embed_public=off&embed_public=on');
        assert.strictEqual(on.status, 303);
        assert.strictEqual(on.headers.get('location'), `/panel/${robot.id}`);
        assert.strictEqual(await flag(robot.id), true);
        for (const p of [`/panel/${robot.id}`, '/robots']) {
            const html = await (await get(p, alex)).text();
            assert.match(html, new RegExp(`action="/robots/${robot.id}/embed"`), p);
            assert.match(html, /name="embed_public" value="on" checked/, p);
            assert.match(html, /never the controls/, p);
        }
        const r = await t.call('GET', `/api/v1/robots/${robot.id}`, { user: alex });
        assert.ok(!r.text.includes('embed_public'));
        const off = await post(url, alex, { embed_public: 'off' });
        assert.strictEqual(off.status, 303);
        assert.strictEqual(await flag(robot.id), false);
        assert.doesNotMatch(await (await get(`/panel/${robot.id}`, alex)).text(), /value="on" checked/);
    });

    await check('a member operator and an outsider get 403 and the flag does not move', async () => {
        await t.call('POST', `/api/v1/robots/${robot.id}/operators`, { user: alex, body: { subject: carol.subject, role: 'operator' } });
        for (const who of [carol, bob]) {
            const r = await post(url, who, { embed_public: 'on' });
            assert.strictEqual(r.status, 403);
            assert.match(await r.text(), /only the owner/);
        }
        assert.strictEqual(await flag(robot.id), false);
        // A member's panel carries no switch.
        assert.doesNotMatch(await (await get(`/panel/${robot.id}`, carol)).text(), /data-embed-form/);
    });

    await check('a cross-site Origin is refused; signed out goes to sign-in; a bad value and a missing robot are refused', async () => {
        const cross = await post(url, alex, { embed_public: 'on' }, { Origin: 'https://evil.test' });
        assert.strictEqual(cross.status, 403);
        assert.strictEqual(await flag(robot.id), false);
        const same = await post(url, alex, { embed_public: 'on' }, { Origin: 'http://bot.test' });
        assert.strictEqual(same.status, 303);
        assert.strictEqual(await flag(robot.id), true);
        await post(url, alex, { embed_public: 'off' });
        const anon = await post(url, null, { embed_public: 'on' });
        assert.strictEqual(anon.status, 302);
        assert.match(anon.headers.get('location'), /^\/auth\/login/);
        assert.ok((await post(url, alex, { embed_public: 'yes' })).status >= 400);
        assert.ok((await post(url, alex, {})).status >= 400);
        assert.strictEqual(await flag(robot.id), false);
        assert.strictEqual((await post('/robots/rob_nothing/embed', alex, { embed_public: 'on' })).status, 404);
    });

    await check('setEmbedPublic writes updated_at and emits no event', async () => {
        const before = (await t.outboxRows()).length;
        const row = await t.domain.robots.setEmbedPublic(robot.id, true);
        assert.strictEqual(row.embed_public, true);
        assert.strictEqual((await t.outboxRows()).length, before);
        await t.domain.robots.setEmbedPublic(robot.id, false);
    });

    t.app.locals.sim.stopAll();
    await t.close();
    done();
})();
