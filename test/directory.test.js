'use strict';
// The robot directory (plan T15 "a robot directory (/robots)"): /robots is public (listed robots, the models, and a
// signed-in person's own robots), an owner lists a robot from its panel, a listed robot has a public page (/r/:id)
// that watches it through the embeddable panel, every model has a page, and adding a robot starts at /robots/new.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { loadProfiles } = require('../server/profiles');

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
    const profiles = [...loadProfiles().values()];
    const { robot } = await t.robot(alex, { name: 'Garage rover', profile_id: 'adeept.adr036', access_policy: 'queue' });

    await check('GET /robots signed out: the models and the way in, no one\'s robots, inside the Frame', async () => {
        const r = await get('/robots');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('cache-control'), /private/);
        const html = await r.text();
        assert.ok(html.includes('<h1>Robots</h1>') && html.includes('navbar-mount') && html.includes('/directory.css'));
        for (const p of profiles) assert.ok(html.includes(`href="/models/${p.id}"`), p.id);
        assert.ok(html.includes('href="/try"') && html.includes('Sign in and add a robot'));
        assert.ok(!html.includes('Your robots') && !html.includes('Garage rover'), 'an unlisted robot is nobody else\'s business');
        assert.ok(html.includes('<a class="dir-card-link" href="/try"><span class="dir-card-head"><b>Simulated rover</b>'), 'the simulated rover is always the first robot to drive');
    });

    await check('signed in: your robots, each marked listed or not, and Add a robot', async () => {
        const html = await (await get('/robots', alex)).text();
        assert.ok(html.includes('Your robots') && html.includes(`href="/panel/${robot.id}"`) && html.includes('Not listed'));
        assert.ok(html.includes('href="/robots/new"'));
        assert.ok(!(await (await get('/robots', bob)).text()).includes('Garage rover'));
    });

    await check('the owner lists it: it shows in the directory and on its own page, watchable by anyone', async () => {
        const listing = `/robots/${robot.id}/listing`;
        assert.strictEqual((await post(listing, bob, 'listed=off&listed=on')).status, 403, 'only the owner');
        assert.strictEqual((await post(listing, alex, 'listed=off&listed=on', { Origin: 'https://evil.test' })).status, 403, 'no cross-site post');
        assert.strictEqual((await post(listing, alex, 'listed=maybe')).status, 422);
        const on = await post(listing, alex, 'listed=off&listed=on');
        assert.strictEqual(on.status, 303);
        assert.strictEqual(on.headers.get('location'), `/panel/${robot.id}`);
        const row = await t.domain.robots.get(robot.id);
        assert.ok(row.listed && row.listed_at && row.embed_public, 'listing makes it watchable');
        const dir = await (await get('/robots')).text();
        assert.ok(dir.includes(`href="/r/${robot.id}"`) && dir.includes('Garage rover') && dir.includes('Adeept ADR036 4WD Smart Car'));
        assert.ok(dir.includes('Anyone signed in can take a timed turn.'));
        const page = await get(`/r/${robot.id}`);
        assert.strictEqual(page.status, 200);
        const html = await page.text();
        assert.ok(html.includes(`<iframe src="/panel/${robot.id}/embed"`), 'it watches through the embeddable panel');
        assert.ok(html.includes(`href="/panel/${robot.id}"`) && html.includes('Take a turn'), 'a queue robot offers a turn');
        assert.match(page.headers.get('content-security-policy'), /frame-src 'self'/);
        assert.strictEqual((await get(`/panel/${robot.id}/embed`)).status, 200, 'and the frame answers a stranger');
        const panel = await (await get(`/panel/${robot.id}`, alex)).text();
        assert.ok(panel.includes(`action="/robots/${robot.id}/listing"`) && /name="listed" value="on" checked/.test(panel) && panel.includes(`href="/r/${robot.id}"`));
        assert.ok((await (await get('/sitemap.xml')).text()).includes(`/r/${robot.id}</loc>`));
    });

    await check('unlisting takes it out; turning off watching unlists it; its page is then the owner\'s only', async () => {
        await post(`/robots/${robot.id}/listing`, alex, 'listed=off');
        let row = await t.domain.robots.get(robot.id);
        assert.ok(!row.listed && row.embed_public, 'unlisting leaves embedding as it was');
        assert.ok(!(await (await get('/robots')).text()).includes(`/r/${robot.id}`));
        assert.strictEqual((await get(`/r/${robot.id}`)).status, 404);
        assert.strictEqual((await get(`/r/${robot.id}`, alex)).status, 200, 'its owner still sees its page');
        await post(`/robots/${robot.id}/listing`, alex, 'listed=on');
        await post(`/robots/${robot.id}/embed`, alex, 'embed_public=off');
        row = await t.domain.robots.get(robot.id);
        assert.ok(!row.listed && !row.embed_public, 'a robot nobody may watch is not listed');
        assert.strictEqual((await get('/r/rob_nothing')).status, 404);
    });

    await check('/models and /models/:id: every model by how it connects, its setup and its panel', async () => {
        const r = await get('/models');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('cache-control'), /^public/);
        const html = await r.text();
        for (const label of ['Simulated', 'On-board', 'Bridge', 'Server-side']) assert.ok(html.includes(`>${label}</h2>`), label);
        const cozmo = await (await get('/models/cozmo')).text();
        assert.ok(cozmo.includes('<h1>Cozmo') && cozmo.includes('How it connects') && cozmo.includes('hardware-cozmo.md') && cozmo.includes('href="/robots/new?profile=cozmo"'));
        const sim = await (await get('/models/sim.rover')).text();
        assert.ok(sim.includes('href="/try"'), 'the simulated rover points at /try');
        assert.strictEqual((await get('/models/nope')).status, 404);
        const sitemap = await (await get('/sitemap.xml')).text();
        for (const p of profiles) assert.ok(sitemap.includes(`/models/${p.id}</loc>`), p.id);
    });

    await check('/robots/new: signed in only; one choice per model, grouped by how it connects, the asked one chosen', async () => {
        const out = await get('/robots/new');
        assert.strictEqual(out.status, 302);
        assert.strictEqual(out.headers.get('location'), `/auth/login?next=${encodeURIComponent('/robots/new')}`);
        const html = await (await get('/robots/new', alex)).text();
        for (const p of profiles) assert.ok(html.includes(`name="profile_id" value="${p.id}"`), p.id);
        assert.match(html, /value="sim\.rover" checked/, 'the simulated rover by default');
        assert.match(await (await get('/robots/new?profile=looi', alex)).text(), /value="looi" checked/);
        const made = await post('/robots', alex, 'name=Desk+friend&profile_id=sim.rover&access_policy=private');
        assert.strictEqual(made.status, 303, 'a simulated rover goes straight to its panel');
    });

    await check('robots.txt: the directory, models and robot pages are crawlable; adding and panels are not', async () => {
        const txt = await (await get('/robots.txt')).text();
        assert.ok(txt.includes('Disallow: /robots/new\n') && txt.includes('Disallow: /panel/\n'));
        assert.ok(!/Disallow: \/robots\n|Disallow: \/r\/|Disallow: \/models/.test(txt));
    });

    t.app.locals.sim.stopAll();
    await t.close();
    done();
})();
