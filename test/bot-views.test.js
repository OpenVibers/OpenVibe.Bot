'use strict';
// The embeddable panel's three views (?mode=panel|overlay|compact): the full panel as before, a transparent
// overlay that draws only the live controls (the first stick, the first slider, the e-stop and "more"), and one
// row for a narrow card. The controls come from the robot's own profile; a host can change the view by message.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');
const { renderPanel } = require('../server/web/render');

const DRIVE = {
    id: 'looi.demo', name: 'LOOI',
    commands: {
        drive: { axes: { throttle: [-1, 1], steer: [-1, 1] } },
        actuator: { names: { head: { type: 'number', range: [-1, 1] }, horn: { type: 'tone', hz: [220, 880] } } },
    },
    widgets: [
        { type: 'camera', label: 'Camera', order: 0 },
        { type: 'drive', label: 'Drive', order: 1, command: { kind: 'drive' } },
        { type: 'head', label: 'Head', order: 2, command: { kind: 'actuator', names: ['head', 'horn'] } },
    ],
};
const ROBOT = { id: 'rob_view1', name: 'LOOI', profile_id: 'looi.demo', estop: { latched: false } };
const render = (over = {}) => renderPanel({
    robot: ROBOT, profile: DRIVE, role: 'owner', allowed_commands: ['drive', 'actuator', 'halt'],
    mode: 'embed', signedIn: true, parentOrigins: ['https://openvibe.live'], ...over,
});

(async () => {
    await check('overlay: transparent page, only the live controls, the state pill, and no full-panel chrome', () => {
        const html = render({ view: 'overlay' });
        assert.ok(html.includes('<html lang="en" class="embed-page bot-mode-overlay" data-bot-view="overlay" data-bot-min-width="280" data-bot-min-height="196">'));
        assert.ok(html.includes('class="embed-page bot-mode-overlay"'));
        assert.ok(html.includes('data-bot-overlay'));
        assert.ok(!html.includes('class="topbar"') && !html.includes('data-estop-banner') && !html.includes('class="widget-camera"'));
        assert.ok(html.includes('data-bot-pill') && html.includes('data-bot-state') && html.includes('>LOOI<'));
        assert.ok(html.includes('data-joystick') && html.includes('data-actuator="head"'));
        assert.ok(html.includes('data-estop') && html.includes('data-bot-more'));
        const hits = html.match(/data-bot-hit/g) || [];
        assert.ok(hits.length >= 5, `pill, stick, slider, e-stop and more each report a hit box (${hits.length})`);
        assert.ok(!html.includes('data-hold=') && !html.includes('data-stop'), 'no pad buttons or stop row in the overlay');
    });

    await check('overlay: the controls a robot has decide what it draws (first stick, first slider, e-stop by role)', () => {
        const ptz = {
            id: 'camera.demo', name: 'Camera',
            commands: { ptz: { axes: { pan: [-1, 1], tilt: [-1, 1], zoom: [-1, 1] } }, actuator: { names: { zoom: { type: 'number', range: [0, 3] } } } },
            widgets: [
                { type: 'ptz', label: 'Pan / tilt', order: 1, command: { kind: 'ptz' } },
                { type: 'pan-tilt', label: 'Zoom', order: 2, command: { kind: 'actuator', names: ['zoom'] } },
            ],
        };
        const cam = renderPanel({ robot: { ...ROBOT, id: 'rob_cam1' }, profile: ptz, role: 'watcher', allowed_commands: [], mode: 'embed', view: 'overlay' });
        assert.ok(cam.includes('data-ptz-stick') && cam.includes('data-actuator="zoom"'));
        assert.ok(!cam.includes('data-estop'), 'a watcher has no e-stop until they take the controls');
        assert.ok(cam.includes('data-bot-more'), 'but there is always a way to the full panel');
        const hornOnly = {
            id: 'horn.demo', name: 'Horn', commands: { actuator: { names: { horn: { type: 'tone', hz: [220, 880] } } } },
            widgets: [{ type: 'horn', label: 'Horn', command: { kind: 'actuator', names: ['horn'] } }],
        };
        const quiet = renderPanel({ robot: ROBOT, profile: hornOnly, role: 'owner', allowed_commands: ['actuator'], mode: 'embed', view: 'overlay' });
        assert.ok(!quiet.includes('data-actuator') && !quiet.includes('data-joystick'), 'a tone is not a slider, and there is no stick');
        assert.ok(quiet.includes('data-estop') && quiet.includes('data-bot-more'));
    });

    await check('compact: one row with the pill, a 96 px stick, the slider across, the e-stop and more', () => {
        const html = render({ view: 'compact' });
        assert.ok(html.includes('class="embed-page bot-mode-compact" data-bot-view="compact" data-bot-min-width="320" data-bot-min-height="112"'));
        assert.ok(html.includes('class="bot-compact"') && !html.includes('data-bot-overlay'));
        assert.ok(html.includes('data-bot-pill') && html.includes('data-joystick') && html.includes('data-actuator="head"'));
        assert.ok(html.includes('data-estop') && html.includes('data-bot-more'));
    });

    await check('panel is the default view: an unknown mode falls back to the full panel and its old markup', () => {
        const html = render({});
        assert.ok(html.includes('data-bot-view="panel"') && html.includes('data-bot-min-width="320"') && html.includes('data-bot-min-height="480"'));
        assert.ok(html.includes('data-estop-banner') && html.includes('class="widgets"'));
        const weird = render({ view: '../../etc/passwd' });
        assert.ok(weird.includes('data-bot-view="panel"') && weird.includes('class="widgets"'));
    });

    await check('the sheet keeps the overlay transparent, click-through, scrimmed and at the sizes the page promises', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.css'), 'utf8');
        assert.ok(/html\.bot-mode-overlay,\s*html\.bot-mode-overlay body,[\s\S]*?background:\s*transparent/.test(css));
        assert.match(css, /body\.bot-mode-overlay,\s*body\.bot-mode-compact \{[^}]*pointer-events:\s*none/);
        assert.match(css, /\.bot-control \{[^}]*pointer-events:\s*auto[^}]*rgba\(8,\s*12,\s*22,\s*0\.42\)[^}]*rgba\(255,\s*255,\s*255,\s*0\.14\)[^}]*blur\(6px\)/);
        assert.match(css, /\.bot-stick \{[^}]*width:\s*132px;\s*height:\s*132px/);
        assert.match(css, /\.bot-slider \{[^}]*width:\s*44px;\s*height:\s*132px/);
        assert.match(css, /\.bot-overlay\.is-idle \{\s*opacity:\s*0\.45/);
        assert.match(css, /prefers-reduced-motion: reduce[^}]*\{[^}]*\.bot-overlay \{\s*transition:\s*none/);
        assert.match(css, /\.bot-compact \.bot-stick \{[^}]*width:\s*96px/);
    });

    await check('the client fades the controls, wakes on a touch, and hands focus back on Escape', () => {
        const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.js'), 'utf8');
        assert.match(js, /setTimeout\(\(\) => botSurface\.classList\.add\('is-idle'\), 4000\)/);
        assert.match(js, /'pointermove', 'pointerdown', 'touchstart', 'keydown'/);
        assert.match(js, /if \(e\.code === 'Escape' && BOT_VIEW !== 'panel'\)/);
        assert.match(js, /type: 'ov-bot-blur-controls'/);
        assert.match(js, /type: 'ov-bot-open-panel'/);
        assert.match(js, /ov-bot-activity/);
        assert.match(js, /paintBotPill/);
    });

    const t = await boot();
    const alex = t.network.newUser('alex');
    const get = (p) => fetch(t.base + p, { redirect: 'manual' });
    const { robot } = await t.robot(alex, { name: 'Overlay rover' });
    await t.domain.robots.setEmbedPublic(robot.id, true);

    await check('GET /panel/:id/embed?mode=… draws each view, and anything else is the panel', async () => {
        const overlay = await get(`/panel/${robot.id}/embed?mode=overlay`);
        assert.strictEqual(overlay.status, 200);
        const over = await overlay.text();
        assert.ok(over.includes('data-bot-view="overlay"') && over.includes('class="embed-page bot-mode-overlay"'), 'overlay view');
        const compact = await (await get(`/panel/${robot.id}/embed?mode=compact`)).text();
        assert.ok(compact.includes('data-bot-view="compact"'), 'compact view');
        const panel = await (await get(`/panel/${robot.id}/embed`)).text();
        assert.ok(panel.includes('data-bot-view="panel"'), 'the default is the full panel');
        const odd = await (await get(`/panel/${robot.id}/embed?mode=constructor`)).text();
        assert.ok(odd.includes('data-bot-view="panel"'), 'an unknown mode never reaches the markup');
        const closed = await (await get(`/panel/${robot.id}/embed?mode=overlay`)).status;
        assert.strictEqual(closed, 200);
    });

    await t.close();
    done();
})();
