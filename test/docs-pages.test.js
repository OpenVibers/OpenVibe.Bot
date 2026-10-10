'use strict';
// The public build pages (plan T15): GET /docs, /docs/drivers and /docs/profiles, the profile validator they
// carry (POST /docs/profiles/validate, POST /api/v1/profiles/validate), and the sitemap that lists them. The
// pages carry no script, so the site-wide CSP stands; the validator runs the same checks a shipped profile does.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

const ROOT = path.join(__dirname, '..');
const sim = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'profiles', 'sim.rover.json'), 'utf8'));
// The app's own CSP (server/app.js), which the docs pages do not loosen.
const SITE_CSP = "default-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'";

(async () => {
    const t = await boot({ openre: false });
    const get = (p, opts) => fetch(t.base + p, { redirect: 'manual', ...opts });
    const form = (profile) => fetch(t.base + '/docs/profiles/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ profile }).toString(),
    });

    await check('GET /docs: the build index, linking both guides and the robots page, under the site CSP', async () => {
        const r = await get('/docs');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /^text\/html/);
        assert.strictEqual(r.headers.get('content-security-policy'), SITE_CSP);
        const html = await r.text();
        assert.match(html, /Build for OpenVibe\.Bot/);
        assert.match(html, /href="\/docs\/drivers"/);
        assert.match(html, /href="\/docs\/profiles"/);
        assert.match(html, /href="\/robots"/);
        assert.ok(!/<script\b/i.test(html), 'no script on a docs page');
    });

    await check('GET /docs/drivers: the guide, connection kinds, every message, safety rules and testing', async () => {
        const r = await get('/docs/drivers');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('content-security-policy'), SITE_CSP);
        const html = await r.text();
        assert.match(html, /Write a driver/);
        assert.match(html, /stdin\/stdout/);
        assert.match(html, /openvibe_plugin/);
        assert.match(html, /dryrun/);
        // The three connection kinds.
        for (const kind of ['onboard', 'bridge', 'server']) assert.ok(html.includes(kind), `no ${kind} connection kind`);
        // The lifecycle.
        for (const step of ['hello', 'describe', 'ready', 'heartbeat']) assert.ok(html.includes(step), `no ${step} in the lifecycle`);
        // Every message type, each with a JSON example.
        for (const op of ['hello', 'command', 'heartbeat', 'stop', 'estop', 'resume', 'describe', 'ready', 'fault', 'ack', 'nack', 'telemetry', 'event', 'video']) {
            assert.ok(html.includes(`&quot;op&quot;: &quot;${op}&quot;`), `no ${op} JSON example`);
        }
        // The safety rules.
        assert.match(html, /must stop every actuator/);
        assert.match(html, /deadline/);
        assert.match(html, /no_heartbeat/);
        assert.match(html, /e-stop/);
        // Links out to the full protocol and the contributor path.
        assert.match(html, /OpenVibe\.Node\/blob\/main\/docs\/plugins\.md/);
        assert.match(html, /OpenVibe\.Node\/blob\/main\/docs\/protocol\.md/);
        assert.match(html, /pull request/);
    });

    await check('GET /docs/profiles: the fields, the sim.rover example and the validator form', async () => {
        const r = await get('/docs/profiles');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('content-security-policy'), SITE_CSP);
        const html = await r.text();
        assert.match(html, /Robot profiles/);
        assert.match(html, /bot\.robot-profile@1/);
        assert.match(html, /sim\.rover/);
        assert.match(html, /action="\/docs\/profiles\/validate"/);
        assert.match(html, /<textarea name="profile"/);
        assert.ok(!/<script\b/i.test(html), 'no script on the profiles page');
    });

    await check('POST /docs/profiles/validate: the shipped sim.rover profile is valid', async () => {
        const r = await form(JSON.stringify(sim));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        const html = await r.text();
        assert.match(html, /This profile is valid\./);
        assert.ok(!/not valid/.test(html), 'no problem is reported');
    });

    await check('POST /docs/profiles/validate: a missing required field is refused with a readable problem', async () => {
        const broken = JSON.parse(JSON.stringify(sim));
        delete broken.name;
        const html = await (await form(JSON.stringify(broken))).text();
        assert.match(html, /This profile is not valid/);
        assert.match(html, /must have required property/);
        assert.match(html, /name/);
    });

    await check('POST /docs/profiles/validate: an unknown driver is refused with a readable problem', async () => {
        const broken = JSON.parse(JSON.stringify(sim));
        broken.mapping.driver = 'bogus';
        const html = await (await form(JSON.stringify(broken))).text();
        assert.match(html, /This profile is not valid/);
        assert.match(html, /mapping\.driver/);
    });

    await check('POST /docs/profiles/validate: malformed JSON and a cross-site post are refused', async () => {
        const html = await (await form('{ not json')).text();
        assert.match(html, /not valid JSON/);
        const r = await fetch(t.base + '/docs/profiles/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
            body: new URLSearchParams({ profile: JSON.stringify(sim) }).toString(),
        });
        assert.strictEqual(r.status, 403);
    });

    await check('POST /api/v1/profiles/validate: valid and broken profiles, as { valid, problems }', async () => {
        const post = (value) => fetch(t.base + '/api/v1/profiles/validate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
        });
        const ok = await (await post(sim)).json();
        assert.strictEqual(ok.valid, true);
        assert.deepStrictEqual(ok.problems, []);
        assert.strictEqual(ok.profile.id, 'sim.rover');

        const missing = JSON.parse(JSON.stringify(sim));
        delete missing.capabilities;
        const a = await (await post(missing)).json();
        assert.strictEqual(a.valid, false);
        assert.ok(a.problems.length > 0 && a.problems.every((p) => typeof p === 'string' && p.length), 'readable problems');
        assert.ok(a.problems.some((p) => /capabilities/.test(p)), 'names the missing field');

        const badDriver = JSON.parse(JSON.stringify(sim));
        badDriver.mapping.driver = 'bogus';
        const b = await (await post(badDriver)).json();
        assert.strictEqual(b.valid, false);
        assert.ok(b.problems.some((p) => /mapping\.driver/.test(p)), 'names the unknown driver');
    });

    await check('GET /sitemap.xml lists the three docs pages', async () => {
        const xml = await (await get('/sitemap.xml')).text();
        for (const p of ['/docs', '/docs/drivers', '/docs/profiles']) assert.ok(xml.includes(`http://bot.test${p}<`), `sitemap has no ${p}`);
    });

    await check('GET / links the build pages', async () => {
        const html = await (await get('/')).text();
        assert.match(html, /href="\/docs"/);
    });

    await t.close();
    done();
})();
