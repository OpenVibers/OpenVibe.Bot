'use strict';
// Draws a robot's panel from its profile, as the server would, against a stand-in /control, and screenshots it at a
// phone's and a computer's width. node scripts/preview-panel.js [profile=looi] [outDir]
// Used to design the panel (plan §AB.50); not part of the server. OV_PLAYWRIGHT=<path to a playwright package> if it is not installed here.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadProfiles } = require('../server/profiles');
const { renderPanel, page, panelScripts } = require('../server/web/render');

const profileId = process.argv[2] || 'looi';
const out = process.argv[3] || path.join(__dirname, '..', 'tmp-preview');
fs.mkdirSync(out, { recursive: true });
const profile = loadProfiles().get(profileId);
if (!profile) { console.error(`no profile ${profileId}`); process.exit(1); }
const robot = { id: 'rob_preview', name: profile.name || profileId, profile_id: profileId, online: true };
const allowed = ['drive', 'actuator', 'tone', 'stop', 'light', 'say', 'emote', 'headlight', 'point'];
const body = renderPanel({ robot, profile, role: 'operator', allowed_commands: allowed, holdResendMs: 150 });
const html = /panel\.js/.test(body) ? body : page(robot.name, body, { scripts: panelScripts(profile) });
const FAKE_WS = `<script>window.WebSocket = class { constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 5); }
  send(t) { const m = JSON.parse(t); if (m.type === 'join') setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'joined', role: 'operator', allowed_commands: ${JSON.stringify(allowed)}, state: { online: true, battery: 0.72 } }) }), 10); }
  close() {} addEventListener() {} removeEventListener() {} };</script>`;
const root = path.join(__dirname, '..', 'public');
const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html.replace('<head>', '<head>' + FAKE_WS)); }
    const shared = path.join(__dirname, '..', 'node_modules', 'openvibe-shared');
    const f = u.startsWith('/shared/') ? path.join(shared, u.slice('/shared/'.length)) : path.join(root, u.startsWith('/panel/') ? u.slice('/panel/'.length) : u.replace(/^\//, ''));
    if ((f.startsWith(root) || f.startsWith(shared)) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : f.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript' }); return res.end(fs.readFileSync(f)); }
    res.writeHead(404); res.end();
});
(async () => {
    const { chromium } = require(process.env.OV_PLAYWRIGHT || 'playwright');
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome' });
    try {
        for (const [w, hgt, mobile] of [[390, 844, true], [1280, 860, false]]) {
            const pg = await browser.newPage({ viewport: { width: w, height: hgt }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark' });
            const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
            await pg.goto(base); await pg.waitForTimeout(900);
            await pg.screenshot({ path: path.join(out, `${profileId}-${w}.png`), fullPage: true });
            const sw = await pg.evaluate(() => document.documentElement.scrollWidth);
            console.log(`${w}: scrollWidth ${sw}${errs.length ? ` errors: ${errs.join(' | ')}` : ''}`);
            await pg.close();
        }
    } finally { await browser.close(); server.close(); }
})();
