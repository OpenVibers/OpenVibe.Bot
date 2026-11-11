'use strict';
// The panel pages carry the Arrange surface (make your own controls, stage 2): the person's layout is drawn on the
// real parts server-side, the editor itself is not loaded until Arrange is pressed, the old pad menu is gone, and
// the overlay marks its own parts. Nothing here changes a robot command.
const assert = require('node:assert/strict');
const render = require('../server/web/render');
const surface = require('../server/web/surface');
const profile = require('../server/profiles/looi.json');
const { validate } = require('openvibe-sdk/ui-layout');

const robot = { id: 'r1', name: 'Looi', profile_id: profile.id, access_policy: 'private', estop: { latched: false } };
const allowed = Object.keys(profile.commands);
const catalog = surface.controlsCatalog(profile);
const defaults = surface.defaultLayout(catalog, 'phone');

function panel(extra = {}) {
    return render.renderPanel({
        robot, profile, role: 'owner', allowed_commands: allowed,
        arrange: {
            catalog, parts: surface.partsOf(profile), layout: defaults, device: 'phone', signedIn: true,
            layoutSource: 'default', src: '/shared/ov-arrange.js?v=abc', save: '/panel/r1/arrange',
            suggest: '/panel/r1/arrange/suggest', share: '/panel/r1/arrange/share', ...extra,
        },
    });
}

const html = panel();
assert.ok(html.includes('data-arrange'), 'the Arrange button is in the panel head');
assert.ok(/data-arrange-src="\/shared\/ov-arrange\.js\?v=abc"/.test(html), 'it names the shared editor to load when pressed');
assert.ok(!/<script[^>]+ov-arrange\.js/.test(html), 'the editor is not loaded until Arrange is pressed');
assert.ok(html.includes('id="ov-arrange-data"'), 'the catalog and layout reach the client as data');
assert.ok(!html.includes('pad-prefs'), 'the old sliders-icon arrangement menu is gone');
assert.ok(html.includes('data-ov-part="stop"') && html.includes('data-ov-part="stick"') && html.includes('data-ov-part="head"'), 'the real parts are marked');
assert.ok(html.includes('data-ov-surface="bot.controls"'), 'the panel names its surface');
assert.ok(!html.includes('data-ov-arranged="true"'), 'without a stored layout the page keeps its own look (the editor applies the grid when opened)');

const stored = surface.defaultLayout(catalog, 'phone');
stored.parts.find((p) => p.id === 'battery').visible = false;
const withLayout = panel({ layout: stored, layoutSource: 'account' });
assert.ok(/data-ov-arranged="true"/.test(withLayout), 'a stored layout draws the arranged grid on the server');
assert.ok(/grid-column:1 \/ span 2/.test(withLayout), 'the stick is drawn in its cells');
assert.ok(/data-ov-part="battery"[^>]*hidden/.test(withLayout) || /hidden[^>]*data-ov-part="battery"/.test(withLayout), 'a hidden readout is hidden before first paint');

const overlayCatalog = surface.overlayCatalog(profile, { slider: { name: 'head' }, hasStick: true, canDrive: false });
const overlay = render.renderPanel({
    robot, profile, role: 'watcher', allowed_commands: [], mode: 'embed', view: 'overlay', signedIn: false,
    arrange: {
        catalog: overlayCatalog, layout: surface.overlayDefaultLayout(overlayCatalog, 'phone'), device: 'phone',
        signedIn: false, layoutSource: 'default', save: '/panel/r1/arrange', suggest: '/panel/r1/arrange/suggest', share: '/panel/r1/arrange/share',
    },
});
for (const id of ['pill', 'stick', 'slider', 'estop', 'more']) assert.ok(overlay.includes(`data-ov-part="${id}"`), `the overlay marks ${id}`);
assert.ok(overlay.includes('data-ov-role-hidden="true"'), 'the watcher’s e-stop stays role-hidden until Drive');
assert.ok(overlay.includes('id="ov-arrange-data"'), 'the overlay carries its catalog and layout too');
assert.ok(overlayCatalog.parts.find((p) => p.id === 'estop').required, 'the overlay catalog makes the e-stop required');

// The default layouts are what the SDK would accept, the one check every surface shares.
assert.deepEqual(validate(catalog, defaults), { ok: true, reasons: [] });
assert.deepEqual(validate(overlayCatalog, surface.overlayDefaultLayout(overlayCatalog, 'phone')), { ok: true, reasons: [] });
console.log('arrange-panel: parts, server-side layout, lazy editor, no old menu, stored layout and overlay');
