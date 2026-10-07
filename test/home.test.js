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
        assert.match(csp, /connect-src 'self' https:\/\/openvibe\.network https:\/\/events\.openvibe\.network/);
        assert.match(csp, /frame-ancestors 'none'/);
        const html = await r.text();
        assert.match(html, /<h1>Drive your robot<span class="sc-accent"> from any browser\.<\/span><\/h1>/);
        assert.match(html, /<meta name="robots" content="index, follow">/);
        assert.match(html, /<link rel="canonical" href="http:\/\/bot\.test\/">/);
        assert.match(html, /href="\/auth\/login\?next=%2Frobots">Sign in with OpenVibe/);
        assert.strictEqual((html.match(/<h1[ >]/g) || []).length, 1, 'one h1');
        const css = html.match(/href="(\/shared\/showcase\.css\?v=[0-9a-f]{12})"/);
        assert.ok(css, 'links the showcase stylesheet');
        const sheet = await get(css[1]);
        assert.strictEqual(sheet.status, 200, 'and serves it');
        assert.match(sheet.headers.get('content-type'), /^text\/css/);
        assert.match(html, /src="\/shared\/navbar\.js\?v=[0-9a-f]{12}"/);
    });

    await check('GET /: no promise the service cannot keep (video waits for OpenRe; no store, no unsupported boards)', async () => {
        const html = await (await get('/')).text();
        assert.match(html, /Live video in the panel arrives when OpenRe\.Stream can play a browser \(WHIP\) stream back/);
        for (const claim of [/ESP32/, /ROS 2/, /Android/, /arrive paired/i, /\bbuy\b/i, /webhook/i]) assert.ok(!claim.test(html), `no ${claim}`);
    });

    await check('GET /: signed in, the first action opens your robots', async () => {
        const html = await (await get('/', alex)).text();
        assert.match(html, /href="\/robots">Your robots/);
        assert.ok(!html.includes('Sign in with OpenVibe</a>'));
    });

    await check('the rest of the site keeps its own CSP', async () => {
        const r = await get('/robots', alex);
        assert.strictEqual(r.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
    });

    await check('the vhost proxies / and /shared/ to the app and keeps the legal pages on the Sites files', async () => {
        const conf = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'openvibe.bot.conf'), 'utf8');
        assert.match(conf, /location \^~ \/shared\/ \{\s*proxy_pass http:\/\/127\.0\.0\.1:4630;\s*\}/);
        assert.ok(!conf.includes('alias /opt/openvibe.sites/dist/_shared/'), 'no second copy of the shared assets');
        assert.match(conf, /location = \/index\.html \{ return 301 \/; \}/, 'the replaced Sites page is never served by name');
        assert.match(conf, /location = \/robots\.txt \{\s*proxy_pass http:\/\/127\.0\.0\.1:4630;\s*\}/);
        assert.match(conf, /location = \/release\.json \{\s*proxy_pass http:\/\/127\.0\.0\.1:4630;\s*\}/);
        assert.match(conf, /location = \/status\.json \{ return 404; \}/);
        assert.match(conf, /location = \/ \{\s*limit_req zone=ovbot_api/);
        assert.match(conf, /root \/opt\/openvibe\.sites\/dist\/openvibe\.bot;/);
    });

    await t.close();
    done();
})();
