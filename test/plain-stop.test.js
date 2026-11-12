'use strict';
// The plain Stop: it is one ordinary part of the panel, off until a person adds it, and pressing it sends the
// machine's own Stop (halt) and nothing else. No latch, no clear, no red bar. Also the words: no page, doc or
// AGENTS.md says E-STOP, estop or emergency stop (inline code names a legacy protocol field and is skipped).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const render = require('../server/web/render');
const surface = require('../server/web/surface');
const profile = require('../server/profiles/looi.json');

const robot = { id: 'rob_stop1', name: 'Looi', profile_id: profile.id, access_policy: 'private' };
const allowed = Object.keys(profile.commands);
const catalog = surface.controlsCatalog(profile);
const defaults = surface.defaultLayout(catalog, 'phone');
const panel = (layout = defaults, layoutSource = 'default') => render.renderPanel({
    robot, profile, role: 'owner', allowed_commands: allowed,
    arrange: {
        catalog, parts: surface.partsOf(profile), layout, device: 'phone', signedIn: true, layoutSource,
        src: '/shared/ov-arrange.js', defaultLayout: defaults,
    },
});

const off = panel();
assert.match(off, /data-ov-part="stop"[^>]*hidden|hidden[^>]*data-ov-part="stop"/, 'Stop is in the layout, hidden');
assert.ok(!/class="[^"]*estop/.test(off), 'no stop bar or overlay stop');

const withStop = JSON.parse(JSON.stringify(defaults));
const entry = withStop.parts.find((p) => p.id === 'stop');
entry.visible = true; entry.place = { x: 0, y: 0, w: 1, h: 1 };
const on = panel(withStop, 'account');
assert.match(on, /<button[^>]*class="stop plain-stop"[^>]*data-stop[^>]*>/, 'the placed Stop is a plain button');
assert.ok(!/data-stop[^>]*class="[^"]*danger/.test(on) && !/danger[^"]*data-stop/.test(on), 'it is not red');
assert.ok(!on.includes('data-estop'), 'no old stop bar');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.js'), 'utf8');
assert.ok(js.includes("send('halt', {});"), 'pressing Stop sends the machine its own halt');
assert.ok(!js.includes("raw({ type: 'estop' })"), 'and nothing else');

// The words: prose only; an inline code name such as `estop_state` is a legacy protocol field.
const files = ['AGENTS.md', 'README.md', 'STATUS.json', ...fs.readdirSync(path.join(__dirname, '..', 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
for (const file of files) {
    let text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    text = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    assert.ok(!/(^|[^A-Za-z])e-?stop([^A-Za-z]|$)/i.test(text), `${file} says e-stop`);
    assert.ok(!/emergency\s+stop/i.test(text), `${file} says emergency stop`);
}
console.log('plain-stop: optional Stop sends halt; prose has no E-STOP');
