'use strict';
// The pages openvibe.bot used to get from the frozen OpenVibe.Sites checkout: the legal pages, the sitemap,
// the web app manifest and the browser-facing 404. Bot serves them itself now, and the nginx vhost no longer
// points at a Sites root.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ openre: false });
    const get = (p) => fetch(t.base + p, { redirect: 'manual' });

    await check('GET /terms, /privacy, /dmca: OpenVibe.Bot legal pages served by the app', async () => {
        for (const p of ['/terms', '/privacy', '/dmca']) {
            const r = await get(p);
            assert.strictEqual(r.status, 200, p);
            assert.match(r.headers.get('content-type'), /^text\/html/, p);
            // The document ships its own inline theme and Frame boot: its CSP must allow them, not the site-wide one.
            assert.match(r.headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline' https:\/\/openvibe\.network/, `${p} lets its Frame boot run`);
            const html = await r.text();
            assert.match(html, /OpenVibe\.Bot/, `${p} names OpenVibe.Bot`);
            assert.match(html, /<h1>/, `${p} has a heading`);
        }
    });

    await check('GET /sitemap.xml: every public page, absolute, named by robots.txt', async () => {
        const robots = await (await get('/robots.txt')).text();
        assert.match(robots, /^Sitemap: http:\/\/bot\.test\/sitemap\.xml$/m, 'robots.txt names the sitemap');
        const r = await get('/sitemap.xml');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /xml/);
        const xml = await r.text();
        for (const p of ['/', '/install', '/terms', '/privacy', '/dmca']) {
            assert.ok(xml.includes(`<loc>http://bot.test${p}</loc>`), `sitemap lists ${p}`);
        }
    });

    await check('GET /manifest.webmanifest: JSON, OpenVibe.Bot / Bot', async () => {
        const r = await get('/manifest.webmanifest');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /application\/(manifest\+)?json/);
        const m = JSON.parse(await r.text());
        assert.strictEqual(m.name, 'OpenVibe.Bot');
        assert.strictEqual(m.short_name, 'Bot');
        assert.strictEqual(m.start_url, '/');
        assert.ok(Array.isArray(m.icons) && m.icons.length > 0, 'has icons');
    });

    await check('an unknown page is the app\'s 404 HTML page; the API keeps its problem+json 404', async () => {
        const page = await get('/no-such-page');
        assert.strictEqual(page.status, 404);
        assert.match(page.headers.get('content-type'), /^text\/html/);
        assert.match(await page.text(), /Not found/);
        const api = await fetch(t.base + '/api/no-such-route');
        assert.strictEqual(api.status, 404);
        assert.match(api.headers.get('content-type'), /application\/problem\+json/);
    });

    await check('the vhost no longer serves anything from a Sites checkout', async () => {
        const conf = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'openvibe.bot.conf'), 'utf8');
        assert.ok(!conf.includes('/opt/openvibe.sites'), 'no Sites path in the vhost');
        assert.ok(!conf.includes('try_files'), 'no static file fallback');
        assert.ok(!/error_page\s+404/.test(conf), 'the app owns the 404 page');
        assert.match(conf, /location \/ \{\s*limit_req zone=ovbot_api burst=20 nodelay;\s*limit_req_status 429;\s*proxy_pass http:\/\/127\.0\.0\.1:4630;\s*\}/, 'location / proxies everything else to the app');
    });

    await t.close();
    done();
})();
