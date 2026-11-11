'use strict';
// The controls over a stream keep their places and their look (Maticus, 2026-11-11: "the on screen controls look
// janky all of the sudden… shows only the top left corner of the virtual joystick. the previous size and position was
// perfect"). Two rules broke them: the locked-control badge made the overlay's stick and slider position: relative
// (#391), which dropped them from their corners to the frame's top; and Controls v2 (#393) styled every #panel stick,
// the overlay's too, at the full panel's size inside its 132 px box. The badge's lock was also a data: image, which the
// panel pages' default-src 'self' refuses (a bare blue dot).
//   node test/overlay-controls-css.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.css'), 'utf8');
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));

// 1. Nothing outside the overlay's own placement rules gives its stick or slider a position.
const placed = rules.filter((r) => /\.bot-(stick|slider)\b(?![\w-])/.test(r.sel) && /(^|;)\s*position\s*:/.test(r.body));
for (const r of placed) {
    const value = (r.body.match(/position\s*:\s*([a-z]+)/) || [])[1];
    assert.ok(['absolute', 'static'].includes(value), `the overlay's stick and slider stay placed: "${r.sel}" sets position: ${value}`);
}

// 2. Controls v2 is the full panel's: every #panel selector after its heading leaves the overlay and the one row out.
const v2 = css.slice(css.indexOf('/* ── Controls v2'));
assert.ok(v2.length > 100, 'the Controls v2 block is there');
const v2rules = [...v2.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1]);
const loose = v2rules.flatMap((sel) => sel.split(',')).map((s) => s.trim()).filter((s) => /#panel(?!:not\(\.bot-surface\))/.test(s));
assert.deepStrictEqual(loose, [], 'Controls v2 selectors are scoped to #panel:not(.bot-surface)');
assert.ok(/\.bot-surface \.stick-dirs\s*\{\s*display:\s*none/.test(css), 'the overlay stick draws its dots, not the v2 marks');

// 3. No data: images: the panel pages run under default-src 'self'.
assert.ok(!/url\(\s*["']?data:/.test(css), 'no data: URL in panel.css (default-src \'self\' refuses it)');
assert.ok(css.includes('url("/panel/lock.svg")'), 'the lock badge is a same-origin file');
const routes = fs.readFileSync(path.join(__dirname, '..', 'server', 'web', 'routes.js'), 'utf8');
assert.ok(routes.includes("r.get('/panel/lock.svg', asset('lock.svg', 'image/svg+xml'))"), 'and the panel serves it');
assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'lock.svg')), 'the file exists');

// 4. No custom property is defined from itself (`--danger: var(--danger, …)` is a cycle: the value is dropped, and every
//    red in the overlay drew transparent, the robot pill's offline dot included).
const cyclic = [...css.matchAll(/(--[a-z0-9-]+)\s*:\s*var\(\s*(--[a-z0-9-]+)/g)].filter((m) => m[1] === m[2]).map((m) => m[1]);
assert.deepStrictEqual(cyclic, [], 'no custom property is defined from itself');

console.log('overlay controls css: all checks passed');
