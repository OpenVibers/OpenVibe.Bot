'use strict';
// The Arrange editor on the real panel, in headless Chrome (make your own controls, stage 2): the panel is drawn
// with its parts, Arrange loads openvibe-shared/ov-arrange.js only when pressed, Stop moves on the grid, Save posts
// the layout to the panel's own route, and Ask OpenVibe previews a suggestion before Keep. No robot and no
// Network: the page is rendered by renderPanel and the two arrange endpoints answer with a stub. Skipped without
// Chrome.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const h = require('openvibe-shared/browser-harness');
const render = require('../server/web/render');
const surface = require('../server/web/surface');
const profile = require('../server/profiles/looi.json');
if (process.env.OV_SKIP_BROWSER === '1' || !h.findChrome()) {
    console.log('arrange-browser: skipped (no Chrome; set CHROME_BIN)');
    process.exit(0);
}
const sharedRoot = path.dirname(require.resolve('openvibe-shared/package.json'));
const catalog = surface.controlsCatalog(profile);
const defaults = surface.defaultLayout(catalog, 'phone');
const allowed = Object.keys(profile.commands);
const robot = { id: 'r1', name: 'Looi', profile_id: profile.id, access_policy: 'private', estop: { latched: false } };
const pageHtml = render.renderPanel({
    robot, profile, role: 'owner', allowed_commands: allowed,
    arrange: {
        catalog, parts: surface.partsOf(profile), layout: defaults, device: 'phone', signedIn: true, layoutSource: 'default',
        src: '/shared/ov-arrange.js', save: '/panel/r1/arrange', suggest: '/panel/r1/arrange/suggest', share: '/panel/r1/arrange/share',
    },
});
const calls = { save: null, suggest: null };
const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && (u.pathname === '/panel/r1/arrange' || u.pathname === '/panel/r1/arrange/suggest')) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const got = JSON.parse(body || '{}');
            res.writeHead(200, { 'content-type': 'application/json' });
            if (u.pathname.endsWith('/suggest')) {
                calls.suggest = got;
                const layout = JSON.parse(JSON.stringify(defaults));
                const stop = layout.parts.find((p) => p.id === 'stop');
                stop.place = { x: 0, y: 0, w: 2, h: 2 };
                const stick = layout.parts.find((p) => p.id === 'stick');
                stick.place = { x: 2, y: 0, w: 2, h: 2 };
                return res.end(JSON.stringify({ ok: true, layout, summary: 'Stop is first, beside the stick.', reasons: [] }));
            }
            calls.save = got;
            return res.end('{"ok":true}');
        });
        return;
    }
    if (u.pathname === '/panel/r1') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(pageHtml); }
    if (u.pathname.startsWith('/panel/')) {
        const file = path.join(__dirname, '..', 'public', u.pathname.slice('/panel/'.length));
        if (fs.existsSync(file)) { res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'application/javascript' }); return res.end(fs.readFileSync(file)); }
    }
    if (u.pathname.startsWith('/shared/')) {
        const file = path.join(sharedRoot, u.pathname.slice('/shared/'.length));
        if (fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'application/javascript' }); return res.end(fs.readFileSync(file)); }
    }
    res.writeHead(404); res.end('no');
});
(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-arrange-bot-'));
    const browser = await h.launch({ tmpDir });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
        const p = await h.openPage(browser, await browser.newContext(), { width: 390, height: 800 });
        await p.goto(base + '/panel/r1', { maxMs: 8000 });
        const until = async (expr) => { const end = Date.now() + 8000; while (Date.now() < end) { const v = await p.evaluate(expr); if (v) return v; await wait(50); } return false; };
        const evalv = (expr) => p.evaluate(expr);
        assert.ok(await until(`!!document.querySelector('[data-arrange]')`), 'the Arrange button is there');
        assert.ok(await evalv(`!window.OVArrange`), 'the editor is not loaded before Arrange is pressed');
        await evalv(`document.querySelector('[data-arrange]').click()`);
        assert.ok(await until(`!!window.OVArrange && !!window.ovArrange`), 'Arrange loads the editor and opens it');
        if (!await until(`!!document.querySelector('[data-ov-custom]')`)) console.log('DEBUG', await evalv(`JSON.stringify({custom: !!document.querySelector('[data-ov-custom]'), surfaces: [...document.querySelectorAll('[data-ov-surface]')].map(e=>e.className+':'+e.getAttribute('data-ov-custom')), bar: !!document.querySelector('.ov-arrange-bar'), status: document.querySelector('.ov-arrange-status') && document.querySelector('.ov-arrange-status').textContent, err: window.__err})`));
        assert.ok(await until(`!!document.querySelector('[data-ov-custom]')`), 'the editor applies the layout to the real surface');
        // The stick and Stop are in their own cells; the old pad wrapper flattens.
        assert.ok(await evalv(`getComputedStyle(document.querySelector('.widget-drive')).display === 'contents'`), 'the drive section flattens so its parts are grid cells');
        const before = await evalv(`window.ovArrange.layout().parts.find((p) => p.id === 'stop').place.x`);
        for (let i = 0; i < 2; i++) await evalv(`(() => { const el = document.querySelector('[data-ov-part="stick"]'); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })()`);
        await evalv(`(() => { const el = document.querySelector('[data-ov-part="stop"]'); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); })()`);
        assert.equal(await evalv(`window.ovArrange.layout().parts.find((p) => p.id === 'stop').place.x`), before - 1, 'Stop moved one cell left');
        await evalv(`document.querySelector('[data-save]').click()`);
        assert.ok(calls.save && calls.save.layout, 'Save posted the layout to the panel route');
        // Ask OpenVibe: previewed, then kept.
        await evalv(`(() => { const f = document.querySelector('form[data-ask]'); f.querySelector('input').value = 'put Stop first'; f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); })()`);
        assert.ok(await until(`!!document.querySelector('.ov-arrange-preview')`), 'the suggestion is previewed');
        await evalv(`document.querySelector('.ov-arrange-preview [data-keep]').click()`);
        assert.equal(await evalv(`window.ovArrange.layout().parts.find((p) => p.id === 'stop').place.x`), 0, 'Keep applied the suggestion');
        assert.ok(calls.suggest && calls.suggest.words === 'put Stop first', 'the words reached the panel route');
        // The Controls v2 store becomes the person's first layout once, then is gone.
        const ctx2 = await browser.newContext();
        const p2 = await h.openPage(browser, ctx2, { width: 390, height: 800 });
        const p2until = async (expr) => { const end = Date.now() + 8000; while (Date.now() < end) { const v = await p2.evaluate(expr); if (v) return v; await wait(50); } return false; };
        await p2.goto(base + '/panel/r1', { maxMs: 8000 });
        await p2.evaluate(`localStorage.setItem('ov-bot-pad-prefs', JSON.stringify({ hand: 'left', size: 'l', readouts: 'off' }))`);
        await p2.goto(base + '/panel/r1', { maxMs: 8000 });
        assert.ok(await p2until(`localStorage.getItem('ov-bot-pad-prefs') === null`), 'the old store is retired after one migration');
        const migrated = JSON.parse(await p2.evaluate(`document.getElementById('ov-arrange-data').textContent`));
        assert.deepEqual(migrated.layout.parts.find((p) => p.id === 'stop').place, { x: 0, y: 0, w: 2, h: 2 }, 'Stop takes the left hand');
        assert.deepEqual(migrated.layout.parts.find((p) => p.id === 'stick').place, { x: 2, y: 0, w: 3, h: 3 }, 'the pad takes its larger size');
        assert.equal(migrated.layout.parts.find((p) => p.id === 'battery').visible, false, 'the readouts are folded');
        assert.ok(await p2until(`!!document.querySelector('.widgets[data-ov-arranged]')`), 'the migrated layout is drawn on the parts');
        assert.equal(JSON.parse(await p2.evaluate(`document.getElementById('ov-arrange-data').textContent`)).layoutSource, 'default', 'the page was drawn from the default before the migration');
        await p2.close();

        console.log('arrange-browser: Arrange on the panel, grid move, Save to the panel route, AI preview and Keep, and the pad store migrated once');
    } finally {
        await browser.close();
        server.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
