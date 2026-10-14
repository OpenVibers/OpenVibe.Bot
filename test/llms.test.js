'use strict';
// /llms.txt and /llms-full.txt (llmstxt.org): the plain-text map of Bot's public pages, built with
// openvibe-shared/seo. The same pages as the sitemap minus /install (a 302 to the installer script, not a
// page); no signed-in or per-robot page, and nothing under the API or /internal.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

// The public pages, in the order the files list them; BASE_URL is fixed by the test harness.
const BASE = 'http://bot.test';
const PATHS = ['/', '/docs', '/docs/drivers', '/docs/profiles', '/docs/automation', '/terms', '/privacy', '/dmca'];
const TITLES = ['OpenVibe.Bot — drive your robot from any browser', 'Build for OpenVibe.Bot', 'Write a driver',
    'Robot profiles', 'Routines, webhooks and your agent', 'Terms of Service', 'Privacy Policy', 'DMCA & Copyright'];

(async () => {
    const t = await boot({ openre: false });
    const get = (p) => fetch(t.base + p);

    await check('GET /llms.txt and /llms-full.txt: 200 text/plain, the OpenVibe.Bot header and the front page', async () => {
        for (const p of ['/llms.txt', '/llms-full.txt']) {
            const r = await get(p);
            assert.strictEqual(r.status, 200, p);
            assert.match(r.headers.get('content-type'), /^text\/plain/, p);
            const body = await r.text();
            assert.ok(body.startsWith('# OpenVibe.Bot\n'), `${p} starts with the site name`);
            assert.match(body, /^> An open control panel for robots/m, `${p} carries a summary`);
        }
        // llms.txt links the front page; llms-full.txt lists it as a page with an absolute URL.
        const index = await (await get('/llms.txt')).text();
        assert.ok(index.includes(`- [${TITLES[0]}](${BASE}/)`), 'llms.txt links the front page');
        const full = await (await get('/llms-full.txt')).text();
        assert.ok(full.includes(`### ${TITLES[0]}`) && full.includes(`URL: ${BASE}/`), 'llms-full.txt lists the front page');
    });

    await check('GET /llms.txt: every public page by title and absolute URL, and no API/internal/signed-in path', async () => {
        const body = await (await get('/llms.txt')).text();
        PATHS.forEach((p, i) => assert.ok(body.includes(`- [${TITLES[i]}](${BASE}${p})`), `llms.txt lists ${p}`));
        for (const bad of ['/api', '/internal', '/panel/']) assert.ok(!body.includes(bad), `llms.txt does not name ${bad}`);
    });

    await check("GET /llms-full.txt: each page's full text under its title and absolute URL", async () => {
        const body = await (await get('/llms-full.txt')).text();
        // One distinctive line from every page's text.
        for (const text of ['OpenVibe.Bot is the open control panel for robots.',
            'Two things are open to build against: a driver',
            'The driver protocol spec for OpenVibe.Bot.',
            'The robot profile format (bot.robot-profile@1)',
            "The terms for using OpenVibe.Bot: who may use it",
            'The privacy policy for OpenVibe.Bot:',
            'How OpenVibe.Bot handles copyright:']) {
            assert.ok(body.includes(text), `llms-full.txt holds "${text}"`);
        }
        TITLES.forEach((title, i) => assert.ok(body.includes(`### ${title}`), `llms-full.txt has ${title}`));
        PATHS.forEach((p) => assert.ok(body.includes(`URL: ${BASE}${p}`), `llms-full.txt has the absolute URL for ${p}`));
        for (const bad of ['/api', '/internal', '/panel/']) assert.ok(!body.includes(bad), `llms-full.txt does not name ${bad}`);
    });

    await t.close();
    done();
})();
