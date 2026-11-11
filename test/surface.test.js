'use strict';
// The panel's arrangeable surfaces (make your own controls, stage 2): bot.controls is built from the robot's own
// widgets, Stop and the overlay's e-stop are required, the default layouts pass openvibe-sdk/ui-layout, and the
// attributes put a person's layout on the real parts.
const assert = require('node:assert/strict');
const { validate } = require('openvibe-sdk/ui-layout');
const surface = require('../server/web/surface');
const looi = require('../server/profiles/looi.json');
const rover = require('../server/profiles/sim.rover.json');

const ids = (catalog) => catalog.parts.map((p) => p.id);
const cat = surface.controlsCatalog(looi);
assert.deepEqual(ids(cat), ['stick', 'stop', 'head', 'battery', 'latency'], 'the LOOI panel: the stick, Stop, the head slider and the readouts');
assert.equal(cat.parts.find((p) => p.id === 'stop').required, true, 'Stop is required');
assert.equal(cat.parts.find((p) => p.id === 'stick').styles.label, false, 'the stick has no label');
for (const device of ['phone', 'tablet', 'computer']) {
    const layout = surface.defaultLayout(cat, device);
    assert.deepEqual(validate(cat, layout), { ok: true, reasons: [] }, `the ${device} default layout is valid`);
}
const roverCat = surface.controlsCatalog(rover);
assert.ok(ids(roverCat).includes('camera') && ids(roverCat).includes('stick') && ids(roverCat).includes('lights'), 'the rover: the camera, the drive stick, Stop and its controls');
assert.ok(ids(roverCat).includes('telemetry.2'), 'a second widget of one type gets its own part');
assert.deepEqual(validate(roverCat, surface.defaultLayout(roverCat, 'phone')), { ok: true, reasons: [] });

const overlay = surface.overlayCatalog(looi, { slider: { name: 'head' }, hasStick: true, canDrive: true });
assert.deepEqual(ids(overlay), ['pill', 'more', 'estop', 'stick', 'slider', 'drive']);
assert.equal(overlay.parts.find((p) => p.id === 'estop').required, true, 'the overlay e-stop is required');
assert.deepEqual(validate(overlay, surface.overlayDefaultLayout(overlay, 'phone')), { ok: true, reasons: [] }, 'the overlay default is valid');

// A hidden readout and a moved Stop reach the element's attributes; a default (not the person's own) leaves the
// page's own look alone and only names the surface.
const layout = surface.defaultLayout(cat, 'phone');
layout.parts.find((p) => p.id === 'battery').visible = false;
assert.match(surface.attrsFor(cat, layout, 'phone', 'battery'), /hidden/, 'a hidden part carries hidden');
const stop = surface.attrsFor(cat, layout, 'phone', 'stop');
assert.match(stop, /grid-column:3 \/ span 2/, 'Stop is beside the stick');
assert.equal((stop.match(/style=/g) || []).length, 1, 'one style attribute');
assert.match(stop, /--ov-part-opacity:1/, 'its opacity comes from the layout');
assert.equal(surface.attrsFor(cat, layout, 'phone', 'stop', { apply: false }), '', 'the default is the page, not the layout');
assert.match(surface.surfaceAttrs(cat, layout, 'phone'), /data-ov-arranged="true"/);
assert.match(surface.surfaceAttrs(cat, layout, 'phone', false), /data-ov-surface="bot.controls"/);
assert.doesNotMatch(surface.surfaceAttrs(cat, layout, 'phone', false), /data-ov-arranged/);

assert.equal(surface.deviceClass({ headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } }), 'phone');
assert.equal(surface.deviceClass({ headers: { 'user-agent': 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' } }), 'tablet');
assert.equal(surface.deviceClass({ headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' } }), 'computer');
console.log('surface: bot.controls and bot.overlay catalogs, required safety parts, valid defaults and part attributes');
