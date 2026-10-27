'use strict';
// The front page of openvibe.bot (server/web/home.js): Bot serves it itself, with the OpenVibe Frame and the
// showcase sections, says only what works today, and keeps the rest of the site under `default-src 'self'`.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ openre: false });
    const alex = t.network.newUser('alex');
    const get = (p, user) => fetch(t.base + p, { redirect: 'manual', headers: user ? { Cookie: `ov_token=${t.network.signUser(user)}` } : {} });

    await check('GET /: the front page, indexable, with the Frame and the showcase stylesheet', async () => {
        const r = await get('/');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /^text\/html/);
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-cache');
        assert.strictEqual(r.headers.get('vary'), 'Cookie');
        const csp = r.headers.get('content-security-policy');
        assert.match(csp, /connect-src 'self' https:\/\/openvibe\.network https:\/\/openvibe\.events/);
        assert.match(csp, /frame-ancestors 'none'/);
        const html = await r.text();
        assert.match(html, /<h1>Drive your robot<span class="sc-accent"> from any browser\.<\/span><\/h1>/);
        assert.match(html, /<meta name="robots" content="index, follow">/);
        assert.match(html, /<link rel="canonical" href="http:\/\/bot\.test\/">/);
        assert.match(html, /href="\/auth\/login\?next=%2Frobots">Sign in with OpenVibe/);
        assert.strictEqual((html.match(/<h1[ >]/g) || []).length, 1, 'one h1');
        // Every robot model in the catalogue (the shipped profiles) has a card under "Robots it drives today".
        const models = (/<section class="sc-sec hm-sec" id="models"[\s\S]*?<\/section>/.exec(html) || [''])[0];
        const names = [...models.matchAll(/<span class="hm-card-head"><b>([^<]+)<\/b>/g)].map((m) => m[1]);
        const shipped = fs.readdirSync(path.join(__dirname, '..', 'server', 'profiles')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'profiles', f), 'utf8')).name);
        assert.deepStrictEqual(names.slice().sort(), shipped.slice().sort(), 'one card per catalogue model');
        assert.match(html, new RegExp(`<b>${shipped.length}</b><span>robot models</span>`), 'the stat row counts the catalogue');
        assert.ok(!/listed robots? online/.test(html), 'no online count while nothing listed is online');
        // The simulated rover is always first under "Drive one now"; nothing else is listed yet.
        const now = (/<section class="sc-sec hm-sec" id="now"[\s\S]*?<\/section>/.exec(html) || [''])[0];
        assert.strictEqual((now.match(/class="hm-card[ "]/g) || []).length, 1);
        assert.match(now, /href="\/try"/);
        // The first kit's parts list, and no jobs section without OpenVibe.Search configured.
        assert.match(html, /<h2 id="kit-h">The first kit: Adeept ADR036/);
        assert.match(html, /<b>4×<\/b><span>TT DC motors<\/span>/);
        assert.ok(!html.includes('id="jobs"'), 'a section with nothing to show is left out');
        // JSON-LD: the site, the app, the models as an ItemList, and the questions the page shows as a FAQPage.
        const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        const types = ld.map((x) => x['@type']);
        for (const t of ['WebSite', 'WebApplication', 'ItemList', 'FAQPage']) assert.ok(types.includes(t), `JSON-LD ${t}`);
        assert.strictEqual(ld.find((x) => x['@type'] === 'ItemList').numberOfItems, shipped.length);
        const faq = (/<section class="sc-sec hm-sec" id="faq"[\s\S]*?<\/section>/.exec(html) || [''])[0];
        const questions = [...faq.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
        assert.deepStrictEqual(ld.find((x) => x['@type'] === 'FAQPage').mainEntity.map((q) => q.name), questions, 'FAQPage holds exactly the questions shown');
        assert.ok(questions.length >= 6);
        // Your own computers: desks for your agents, desk hosts, your own models, a desk live (the Desks plan, AI on your
        // own machines), with the questions people ask about them.
        assert.match(html, /<h2 id="computers-h">Your computers, for your agents and your AI<\/h2>/);
        for (const card of ['A desk for each task', 'A spare computer as a desk host', 'Your own AI models', 'A desk live on your channel']) assert.ok(html.includes(`<b>${card}</b>`), card);
        assert.ok(questions.includes('Can my agents use my computer?') && questions.includes('Can my AI use the models on my computer?'));
        const home = await get('/home.css');
        assert.strictEqual(home.status, 200);
        assert.match(home.headers.get('content-type'), /^text\/css/);
        const css = html.match(/href="(\/shared\/showcase\.css\?v=[0-9a-f]{12})"/);
        assert.ok(css, 'links the showcase stylesheet');
        const sheet = await get(css[1]);
        assert.strictEqual(sheet.status, 200, 'and serves it');
        assert.match(sheet.headers.get('content-type'), /^text\/css/);
        assert.match(html, /src="\/shared\/navbar\.js\?v=[0-9a-f]{12}"/);
    });

    await check('GET /: no promise the service cannot keep (video waits for OpenRestream; no store, no unsupported boards)', async () => {
        const html = await (await get('/')).text();
        assert.match(html, /sends its camera over WebRTC to OpenRestream and the panel plays it live/);
        // ROS 2 left this list with Bot#95 (ros2.diffdrive, ros2.holonomic, the Node's plugins/ros2 driver).
        // Webhooks left this list when they shipped (routines and webhooks, migration 0011, /docs/automation).
        for (const claim of [/ESP32/, /Android/, /arrive paired/i, /\bbuy\b/i]) assert.ok(!claim.test(html), `no ${claim}`);
    });

    await check('GET /: a listed robot shows under "Drive one now", online first, and the stat row counts it', async () => {
        const { robot: rover } = await t.robot(alex, { name: 'Arena rover', profile_id: 'sim.rover', access_policy: 'queue' });
        const { robot: car } = await t.robot(alex, { name: 'Garage car', profile_id: 'adeept.adr036' });
        await t.domain.robots.setListed(car.id, true);
        await t.domain.robots.setListed(rover.id, true);
        await t.app.locals.sim.attach(rover.id);
        const html = await (await get('/')).text();
        const now = (/<section class="sc-sec hm-sec" id="now"[\s\S]*?<\/section>/.exec(html) || [''])[0];
        const cards = [...now.matchAll(/<b>([^<]+)<\/b><span class="hm-state" data-state="(\w+)"/g)].map((m) => `${m[1]}:${m[2]}`);
        assert.deepStrictEqual(cards, ['Simulated rover:online', 'Arena rover:online', 'Garage car:offline']);
        assert.match(now, new RegExp(`href="/r/${car.id}"`));
        assert.match(now, /Adeept ADR036 4WD Smart Car · @alex/);
        assert.match(html, /<b>1<\/b><span>listed robot online<\/span>/);
        await t.domain.robots.setListed(car.id, false);
        await t.domain.robots.setListed(rover.id, false);
    });

    await check('GET /: signed in, the first action opens your robots', async () => {
        const html = await (await get('/', alex)).text();
        assert.match(html, /href="\/robots">Your robots/);
        assert.ok(!html.includes('Sign in with OpenVibe</a>'));
    });

    await check('the rest of the site keeps its own CSP', async () => {
        const r = await get('/pair/rob_nothing', alex);
        assert.strictEqual(r.headers.get('content-security-policy'), "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
    });

    await check('the vhost proxies / and /shared/ to the app; the legal pages are the app\'s, not the Sites files', async () => {
        const conf = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'openvibe.bot.conf'), 'utf8');
        assert.match(conf, /location \^~ \/shared\/ \{\s*proxy_pass http:\/\/127\.0\.0\.1:4630;\s*\}/);
        assert.ok(!conf.includes('alias /opt/openvibe.sites/dist/_shared/'), 'no second copy of the shared assets');
        assert.ok(!conf.includes('/opt/openvibe.sites'), 'nothing is served from a Sites checkout');
        assert.match(conf, /location = \/index\.html \{ return 301 \/; \}/, 'the replaced Sites page is never served by name');
        assert.match(conf, /location = \/robots\.txt \{\s*proxy_pass http:\/\/127\.0\.0\.1:4630;\s*\}/);
        assert.match(conf, /location = \/release\.json \{\s*proxy_pass http:\/\/127\.0\.0\.1:4630;\s*\}/);
        assert.match(conf, /location = \/status\.json \{ return 404; \}/);
        assert.match(conf, /location = \/ \{\s*limit_req zone=ovbot_api/);
        assert.match(conf, /location \/ \{\s*limit_req zone=ovbot_api burst=20 nodelay;\s*limit_req_status 429;\s*proxy_pass http:\/\/127\.0\.0\.1:4630;\s*\}/, 'location / proxies everything else to the app');
        assert.ok(!conf.includes('try_files'), 'no static file fallback');
        assert.ok(!/error_page 404/.test(conf), 'the app owns the 404 page');
    });

    await t.close();
    done();
})();
