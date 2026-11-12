'use strict';
// The panel's arrangeable surfaces (make your own controls, stage 2): bot.controls is built from the robot's own
// widgets, Stop is one optional part, the default layouts pass openvibe-sdk/ui-layout, and the
// attributes put a person's layout on the real parts.
const assert = require('node:assert/strict');
const { validate } = require('openvibe-sdk/ui-layout');
const surface = require('../server/web/surface');
const looi = require('../server/profiles/looi.json');
const rover = require('../server/profiles/sim.rover.json');

const ids = (catalog) => catalog.parts.map((p) => p.id);
const cat = surface.controlsCatalog(looi);
assert.deepEqual(ids(cat), ['stick', 'head', 'battery', 'latency', 'stop'], 'the LOOI panel: the stick, the head slider, the readouts and the optional Stop');
assert.equal(cat.parts.find((p) => p.id === 'stop').required, false, 'Stop is optional');
assert.equal(cat.parts.find((p) => p.id === 'stick').styles.label, false, 'the stick has no label');
for (const device of ['phone', 'tablet', 'computer']) {
    const layout = surface.defaultLayout(cat, device);
    assert.deepEqual(validate(cat, layout), { ok: true, reasons: [] }, `the ${device} default layout is valid`);
    assert.equal(layout.parts.find((p) => p.id === 'stop').visible, false, `Stop is off in the ${device} default`);
}
const roverCat = surface.controlsCatalog(rover);
assert.ok(ids(roverCat).includes('camera') && ids(roverCat).includes('stick') && ids(roverCat).includes('lights') && ids(roverCat).includes('stop'), 'the rover: the camera, the drive stick, its controls and the optional Stop');
assert.ok(ids(roverCat).includes('telemetry.2'), 'a second widget of one type gets its own part');
assert.deepEqual(validate(roverCat, surface.defaultLayout(roverCat, 'phone')), { ok: true, reasons: [] });

const overlay = surface.overlayCatalog(looi, { slider: { name: 'head' }, hasStick: true, canDrive: true });
assert.deepEqual(ids(overlay), ['pill', 'more', 'stop', 'stick', 'slider', 'drive']);
assert.equal(overlay.parts.find((p) => p.id === 'stop').required, false, 'the overlay Stop is optional');
assert.deepEqual(validate(overlay, surface.overlayDefaultLayout(overlay, 'phone')), { ok: true, reasons: [] }, 'the overlay default is valid');

// A hidden readout and a moved Stop reach the element's attributes; a default (not the person's own) leaves the
// page's own look alone and only names the surface.
const layout = surface.defaultLayout(cat, 'phone');
layout.parts.find((p) => p.id === 'battery').visible = false;
assert.match(surface.attrsFor(cat, layout, 'phone', 'battery'), /hidden/, 'a hidden part carries hidden');
const stop = surface.attrsFor(cat, layout, 'phone', 'stop');
assert.match(stop, /hidden/, 'Stop is hidden until a person adds it');
const head = surface.attrsFor(cat, layout, 'phone', 'head');
assert.match(head, /grid-column:/, 'a visible part carries its grid place');
assert.equal((head.match(/style=/g) || []).length, 1, 'one style attribute');
assert.match(head, /--ov-part-opacity:1/, 'its opacity comes from the layout');
assert.equal(surface.attrsFor(cat, layout, 'phone', 'head', { apply: false }), '', 'the default is the page, not the layout');
assert.match(surface.surfaceAttrs(cat, layout, 'phone'), /data-ov-arranged="true"/);
assert.match(surface.surfaceAttrs(cat, layout, 'phone', false), /data-ov-surface="bot.controls"/);
assert.doesNotMatch(surface.surfaceAttrs(cat, layout, 'phone', false), /data-ov-arranged/);

assert.equal(surface.deviceClass({ headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } }), 'phone');
assert.equal(surface.deviceClass({ headers: { 'user-agent': 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' } }), 'tablet');
assert.equal(surface.deviceClass({ headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' } }), 'computer');
console.log('surface: bot.controls and bot.overlay catalogs, optional Stop, valid defaults and part attributes');
