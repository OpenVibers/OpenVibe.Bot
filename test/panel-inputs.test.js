'use strict';
// Every way to drive from the panel (Maticus, 2026-10-27: "getting those buttons on openvibe.live stream page (along with
// WASD keyboard AND GaMe cOnTrOlLeR!! … maybe we can add that cool virtual joystick from the sim … would work killer for
// LOOI or any PTZ"):
// - A robot made of buttons (a relay profile: Cozmo's forward/back/left/right, Cozmo Hobo's forward/backward/turn_left/
//   turn_right) with no drive of its own gets the joystick, and WASD, the arrows and a gamepad press its direction buttons.
// - A pan-tilt camera gets the joystick for pan and tilt; zoom stays on its buttons.
// - Framed by an allowed page (a Live channel), the panel says while its controls are live and which keys they take
//   (ov-bot-controls), and takes that page's keys (ov-bot-key) and gamepad (ov-bot-pad) only from it, for its robot, while
//   it drives; a key's release always goes through.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { check, done } = require('./helpers/app');
const { loadProfiles } = require('../server/profiles');
const { renderWidget } = require('../server/web/render');

const relay = (names) => {
    const base = loadProfiles().get('relay.generic');
    return { ...base, commands: { ...base.commands, button: { names: Object.fromEntries(names.map((n) => [n, { label: n }])) } } };
};
const buttonsOf = (profile, allowed = ['button']) => renderWidget(profile.widgets.find((w) => w.type === 'buttons'), { profile, allowed_commands: allowed });

(async () => {
    await check('a robot made of direction buttons gets the joystick and the key hint, enabled only when it may press', () => {
        for (const names of [['back', 'left', 'light', 'right', 'forward', 'lift_up'], ['forward', 'backward', 'turn_left', 'turn_right', 'head_up']]) {
            const html = buttonsOf(relay(names));
            assert.match(html, /<div class="stick stick--buttons" data-button-stick role="img" aria-label="Joystick: presses forward, back, left, right\. Drag and hold to drive\.">/, names.join());
            assert.ok(html.includes('<kbd>W A S D</kbd> or arrows press forward, back, left, right.'), names.join());
            assert.ok(html.indexOf('data-button-stick') < html.indexOf('class="button-grid"'), 'the stick above the buttons');
            for (const n of names) assert.ok(html.includes(`data-button-name="${n}"`), `${n} is still its own button`);
            assert.match(buttonsOf(relay(names), []), /data-button-stick[^>]*aria-disabled="true"/, 'disabled without the button kind');
        }
        // Two directions are enough (forward and back on a slider); one is not.
        assert.ok(buttonsOf(relay(['forward', 'back'])).includes('Joystick: presses forward, back.'));
        assert.ok(!buttonsOf(relay(['forward', 'horn'])).includes('data-button-stick'));
        // OBS scenes are buttons with no direction: no stick.
        assert.ok(!buttonsOf(relay(['scene_cam1', 'scene_cam2', 'scene_obs_test'])).includes('data-button-stick'));
        // A robot that has a drive drives with that, never with its buttons.
        const withDrive = relay(['forward', 'back', 'left', 'right']);
        withDrive.widgets = [{ type: 'drive', label: 'Drive', order: 0, command: { kind: 'drive' } }, ...withDrive.widgets];
        assert.ok(!buttonsOf(withDrive).includes('data-button-stick'));
    });

    await check('a pan-tilt camera gets the joystick for pan and tilt, its axes and zoom buttons kept', () => {
        const cam = loadProfiles().get('camera.onvif');
        const w = cam.widgets.find((x) => x.type === 'ptz');
        const html = renderWidget(w, { profile: cam, allowed_commands: ['ptz'] });
        const stick = /<div class="stick stick--ptz" data-ptz-stick="([^"]*)" data-axes="([^"]*)"[^>]*>/.exec(html);
        assert.ok(stick, html.slice(0, 400));
        const unq = (s) => JSON.parse(s.replace(/&quot;/g, '"'));
        assert.deepStrictEqual(unq(stick[1]), { x: 'pan', y: 'tilt' });
        assert.deepStrictEqual(unq(stick[2]), cam.commands.ptz.axes);
        assert.ok(html.includes('class="ptz-pad"') && html.includes('class="pad"'), 'the buttons stay, zoom among them');
        assert.match(renderWidget(w, { profile: cam, allowed_commands: [] }), /data-ptz-stick[^>]*aria-disabled="true"/);
        // Zoom alone has nothing to steer.
        const zoomOnly = { ...cam, commands: { ...cam.commands, ptz: { axes: { zoom: [-1, 1] } } } };
        assert.ok(!renderWidget(w, { profile: zoomOnly, allowed_commands: ['ptz'] }).includes('data-ptz-stick'));
    });

    await check('panel.js: keys, stick and gamepad press direction buttons; the PTZ stick holds pan and tilt', () => {
        const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.js'), 'utf8');
        assert.ok(js.includes("const KEY_DIR = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };"));
        assert.ok(js.includes("const buttonDrive = !Object.keys(driveAxes).length && Object.keys(DIR_NAMES).filter(dirButton).length >= 2;"), 'only with no drive');
        assert.ok(/if \(buttonDrive && KEY_DIR\[e\.code\] && dirButton\(KEY_DIR\[e\.code\]\)\)/.test(js), 'keydown presses');
        assert.ok(js.includes('if (KEY_DIR[e.code]) dirRelease(KEY_DIR[e.code], `key:${e.code}`);'), 'keyup releases');
        assert.ok(/if \(el\.dataset\.buttonHold === 'true'\) \{ pressProfileButton\(el, source\); return true; \}/.test(js), 'a hold button is held');
        assert.ok(js.includes('dirRepeats.set(k, setInterval(() => pressProfileButton(el, source), REPEAT_MS));'), 'a plain one repeats');
        assert.ok(js.includes("holdSet(kind, 'ptzstick', { [map.x]: at(map.x, x * k), [map.y]: at(map.y, y * k) });"));
        assert.ok(js.includes("() => holdRelease(kind, 'ptzstick'));"), 'let go stops the camera');
        assert.ok(js.includes("for (const k of [...dirRepeats.keys()]) { const i = k.indexOf('|'); dirRelease(k.slice(0, i), k.slice(i + 1)); }"), 'releaseAll lets every repeat go');
        assert.ok(/\[data-joystick\], \[data-button-stick\], \[data-ptz-stick\]/.test(js), 'the new sticks follow the allowed state');
        // The pad on a button robot keeps the drive's latch, B lets go, Start is the e-stop.
        const branch = js.slice(js.indexOf('if (buttonDrive) {', js.indexOf('function padPoll')), js.indexOf('const v = stickValue(ax(0), -ax(1), PAD_DEADZONE);'));
        assert.ok(branch.includes('if (!pad.latched) pad.reset();') && branch.includes('if (!want && !now.size) pad.latched = false;'));
        assert.ok(branch.includes('now.has(1) && !pad.down.has(1)') && branch.includes('now.has(9) && !pad.down.has(9)'));
    });

    await check('panel.js: the page around the frame gets the controls state and may send keys and its gamepad, nothing else', () => {
        const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.js'), 'utf8');
        assert.ok(js.includes("const msg = { type: 'ov-bot-controls', robot_id: ROBOT_ID, active: keys.length > 0, keys, pad: keys.length > 0 };"));
        assert.ok(js.includes('const keys = driving && joined ? controlKeys() : [];'), 'active only while driving');
        assert.ok(js.includes('try { window.parent.postMessage(msg, origin); }'), 'only to the allowed origins');
        assert.ok(/stopDriving\(text\) \{\n\s+driving = false; watcher = true; ticket = null;\n\s+announceControls\(\);/.test(js), 'ending the drive says so');
        const listener = js.slice(js.indexOf("window.addEventListener('message', (e) => {"));
        assert.ok(listener.indexOf("if (!fromPopup && !fromParent) return;") < listener.indexOf("d.type === 'ov-bot-key'"), 'from the allowed page only');
        assert.ok(listener.includes("if (fromParent && d.robot_id === ROBOT_ID && d.type === 'ov-bot-key' && typeof d.code === 'string') {"));
        assert.ok(listener.includes('if (d.down && !(driving && joined)) return;'), 'a press only while driving; a release always');
        assert.ok(listener.includes("if (fromParent && d.robot_id === ROBOT_ID && d.type === 'ov-bot-pad') {") && listener.includes('if (!(driving && joined)) return;'));
        assert.ok(listener.includes('Math.max(-1, Math.min(1, Number(v)))') && listener.includes('.map((b) => b === true)'), 'the pad is clamped and typed');
        assert.ok(js.includes('const profileKey = (e) => (e.remote || main.contains(document.activeElement)) &&'));
    });

    done();
})();
