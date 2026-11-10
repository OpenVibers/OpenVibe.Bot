'use strict';
// Q and E tilt LOOI's head (Maticus, 2026-11-10: "the legend under the virtual joystick says 'Q, E to turn,' but pressing Q
// or E does nothing … I want Q and E to tilt LOOI's head"). They were bound to the drive's `rotation` axis, which LOOI's
// drive (throttle, steer) does not have, so the handler found nothing to send. In a real headless Chrome, against LOOI's
// own panel (renderPanel with the looi profile) and a stand-in for /control that records every frame:
//   - Q tilts up, E tilts down, through the head slider's command (actuator, name head), one step a hold tick (90 ms);
//   - the slider follows, so a drag after the keys starts where the head is going; the value stays in the range;
//   - release sends nothing more (no head 0: that is Center); Q and E together send nothing;
//   - typing in a text field never tilts; blur, Space (stop) and a lost socket stop the repeats;
//   - with no drive allowed (a camera-only mode) the keys still tilt, and the page around the frame is offered Q and E;
//   - a viewer who may not send actuator commands tilts nothing;
//   - the legend says "Q / E to tilt" on LOOI.
// Skipped (exit 0) without Chrome or with OV_SKIP_BROWSER=1.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadProfiles } = require('../server/profiles');
const { renderPanel, page, panelScripts } = require('../server/web/render');

let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const CHROME = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && fs.existsSync(p));
if (process.env.OV_SKIP_BROWSER === '1' || !chromium || !CHROME) { console.log('panel-head-keys-chrome: skipped (no Chrome or Playwright)'); process.exit(0); }

const profile = loadProfiles().get('looi');
const robot = { id: 'rob_test', name: 'LOOI', profile_id: 'looi', online: true };
const html = (allowed) => { const body = renderPanel({ robot, profile, role: 'operator', allowed_commands: allowed, holdResendMs: 150 }); return /panel\.js/.test(body) ? body : page('LOOI', body, { scripts: panelScripts(profile) }); };
// A stand-in WebSocket: answers join with the allowed commands and records every command frame.
const FAKE_WS = (allowed) => `<script>
window.__sent = []; window.__sockets = [];
window.WebSocket = class { constructor() { this.readyState = 0; window.__sockets.push(this);
  setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 5); }
  send(t) { const m = JSON.parse(t); if (m.type === 'join') setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'joined', role: 'operator', allowed_commands: ${JSON.stringify(allowed)}, state: { online: true } }) }), 5);
    else window.__sent.push({ at: performance.now(), ...m }); }
  close() { this.readyState = 3; this.onclose && this.onclose({ code: 1006, reason: '' }); } addEventListener() {} removeEventListener() {} };
</script>`;

const root = path.join(__dirname, '..', 'public');
let allowedNow = ['drive', 'actuator'];
const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html(allowedNow).replace('<head>', '<head>' + FAKE_WS(allowedNow))); }
    const f = u.startsWith('/panel/') ? path.join(root, u.slice('/panel/'.length)) : null;
    if (f && fs.existsSync(f)) { res.writeHead(200, { 'content-type': u.endsWith('.css') ? 'text/css' : 'application/javascript' }); return res.end(fs.readFileSync(f)); }
    res.writeHead(404); res.end();
});

(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ executablePath: CHROME });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const heads = (pg) => pg.evaluate(() => window.__sent.filter((m) => m.type === 'command' && m.kind === 'actuator' && m.value && m.value.name === 'head').map((m) => m.value.value));
    try {
        const open = async (allowed) => {
            allowedNow = allowed;
            const pg = await browser.newPage();
            await pg.goto(base);
            await pg.waitForFunction(() => document.querySelector('[data-actuator="head"]') && !document.querySelector('[data-actuator="head"]').disabled, null, { timeout: 4000 });
            await pg.evaluate(() => { document.body.focus(); window.__sent.length = 0; });
            return pg;
        };
        // Q up, E down, a step a tick, the slider follows, nothing after release.
        let pg = await open(['drive', 'actuator']);
        assert.match(await pg.evaluate(() => document.querySelector('.hint').textContent), /W A S D or arrows to drive · Q \/ E to tilt · Space to stop\./, 'the legend says what Q and E do on LOOI');
        await pg.keyboard.down('KeyQ'); await wait(470); await pg.keyboard.up('KeyQ');
        const up = await heads(pg);
        assert.ok(up.length >= 5 && up.length <= 7, `Q held ~470 ms sends a head command about every 90 ms (${up.length})`);
        assert.ok(up.every((v, i) => i === 0 || v > up[i - 1]), `each one higher: tilt up (${up.join(' ')})`);
        assert.strictEqual(Number(await pg.evaluate(() => document.querySelector('[data-actuator="head"]').value)), up[up.length - 1], 'the slider shows where the head is going');
        const n = up.length; await wait(300);
        assert.strictEqual((await heads(pg)).length, n, 'nothing is sent after release, not even head 0');
        await pg.evaluate(() => { window.__sent.length = 0; });
        await pg.keyboard.down('KeyE'); await wait(200); await pg.keyboard.up('KeyE');
        const down = await heads(pg);
        assert.ok(down.length >= 2 && down[0] < up[up.length - 1] && down.every((v, i) => i === 0 || v < down[i - 1]), `E tilts down from where Q left it (${down.join(' ')})`);
        // The range holds.
        await pg.evaluate(() => { window.__sent.length = 0; });
        await pg.keyboard.down('KeyQ'); await wait(4500); await pg.keyboard.up('KeyQ');
        const top = await heads(pg);
        assert.ok(top.every((v) => v <= 1) && top[top.length - 1] === 1, `clamped to the head's range (${top.slice(-3).join(' ')})`);
        // Q and E together: nothing; letting go of one moves with the other.
        await pg.evaluate(() => { window.__sent.length = 0; });
        await pg.keyboard.down('KeyE'); await pg.keyboard.down('KeyQ'); const both = (await heads(pg)).length; await wait(300);
        assert.strictEqual((await heads(pg)).length, both, 'Q and E held together send nothing');
        await pg.keyboard.up('KeyQ'); await wait(200); await pg.keyboard.up('KeyE');
        assert.ok((await heads(pg)).length > both, 'letting go of Q leaves E tilting down');
        // Typing in a text field never tilts.
        await pg.evaluate(() => { const i = document.createElement('input'); i.type = 'text'; i.id = 'chat'; document.body.append(i); i.focus(); window.__sent.length = 0; });
        await pg.keyboard.down('KeyQ'); await wait(250); await pg.keyboard.up('KeyQ');
        assert.strictEqual((await heads(pg)).length, 0, 'Q in a text field is a letter');
        assert.strictEqual(await pg.evaluate(() => document.getElementById('chat').value), 'q', 'and it is typed');
        // Blur, Space and a lost socket stop the repeats.
        await pg.evaluate(() => { document.getElementById('chat').blur(); document.body.focus(); });
        for (const stopper of ['blur', 'space', 'socket']) {
            await pg.evaluate(() => { window.__sent.length = 0; });
            await pg.keyboard.down('KeyQ'); await wait(150);
            if (stopper === 'blur') await pg.evaluate(() => window.dispatchEvent(new Event('blur')));
            if (stopper === 'space') await pg.keyboard.press('Space');
            if (stopper === 'socket') await pg.evaluate(() => window.__sockets[window.__sockets.length - 1].close());
            const at = (await heads(pg)).length; await wait(300);
            assert.strictEqual((await heads(pg)).length, at, `${stopper} stops the repeats`);
            await pg.keyboard.up('KeyQ');
            if (stopper === 'socket') break;
        }
        await pg.close();
        // No drive allowed (a camera-only mode): Q and E still tilt, and the page around the frame is offered them.
        pg = await open(['actuator']);
        await pg.keyboard.down('KeyQ'); await wait(200); await pg.keyboard.up('KeyQ');
        assert.ok((await heads(pg)).length >= 2, 'the head tilts with no drive allowed');
        await pg.close();
        // A viewer who may not send actuator commands: nothing.
        pg = await browser.newPage(); allowedNow = ['drive'];
        await pg.goto(base); await wait(300);
        await pg.evaluate(() => { document.body.focus(); window.__sent.length = 0; });
        await pg.keyboard.down('KeyQ'); await wait(250); await pg.keyboard.up('KeyQ');
        assert.strictEqual((await heads(pg)).length, 0, 'no head command without actuator permission');
        await pg.close();
        console.log('panel-head-keys-chrome: Q tilts up and E down at the hold cadence through the head command, the slider follows, release sends nothing, both held send nothing, text fields and a viewer never tilt, blur/Space/a lost socket stop it, camera-only tilts, the legend says so');
    } finally {
        await browser.close();
        server.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
