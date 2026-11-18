'use strict';
/**
 * Crowd mixers, stage 1 (plan §H2, Maticus's mixer): each style, expiry, one vote per person, the owner and mods
 * overriding, and a property test that no input can push a crowd's result past the viewer cap or any result past
 * the robot's ranges.
 */
const assert = require('assert');
const { mix, configOf, STYLES, MANIFESTS } = require('../server/crowd/mixers');

const T = 1_000_000;
const AXES = { throttle: [-1, 1], steer: [-1, 1] };
const cfg = (style, extra = {}) => ({ style, axes: AXES, cap: 1, ...extra });
const at = (ms) => T - ms;
let n = 0;
const check = (name, fn) => { fn(); n++; };

check('every style has a manifest, and an unknown style is Mixed', () => {
    assert.deepStrictEqual(Object.keys(MANIFESTS).sort(), [...STYLES].sort());
    assert.strictEqual(configOf({ style: 'chaos', axes: AXES }).style, 'mixed');
    assert.strictEqual(configOf({ windowMs: 5, axes: AXES }).windowMs, 50, 'the window is at least 50 ms');
});

check('nobody pressing, or only stale inputs: idle', () => {
    assert.strictEqual(mix([], cfg('mixed'), T).why, 'idle');
    const stale = [{ who: 'a', role: 'viewer', axes: { throttle: 1 }, at: at(300) }];
    const r = mix(stale, cfg('tug'), T);
    assert.deepStrictEqual([r.axes, r.why], [null, 'idle'], 'an input older than 250 ms does not count');
});

check('Tug-of-war: the average, equal weight; opposite pulls cancel', () => {
    const r = mix([
        { who: 'a', role: 'viewer', axes: { throttle: 1, steer: 1 }, at: at(10) },
        { who: 'b', role: 'anon', axes: { throttle: 1, steer: -1 }, at: at(20) },
        { who: 'c', role: 'viewer', axes: { throttle: -1, steer: 0 }, at: at(30) },
    ], cfg('tug'), T);
    assert.strictEqual(r.why, 'tug');
    assert.ok(Math.abs(r.axes.throttle - 1 / 3) < 1e-9 && Math.abs(r.axes.steer) < 1e-9, JSON.stringify(r.axes));
    assert.strictEqual(r.telemetry.people, 3);
});

check('one person counts once, however fast they press', () => {
    const spam = Array.from({ length: 40 }, (_, i) => ({ who: 'spammer', role: 'anon', axes: { throttle: 1 }, at: at(i) }));
    const r = mix([...spam, { who: 'b', role: 'viewer', axes: { throttle: -1 }, at: at(100) }], cfg('tug'), T);
    assert.ok(Math.abs(r.axes.throttle) < 1e-9, `40 presses are one vote (${r.axes.throttle})`);
    assert.deepStrictEqual(r.telemetry.top[0], { who: 'spammer', inputs: 40 }, 'but the telemetry sees who is busiest');
});

check('Last input wins: the freshest drives', () => {
    const r = mix([
        { who: 'a', role: 'viewer', axes: { throttle: 1 }, at: at(100) },
        { who: 'b', role: 'viewer', axes: { throttle: -0.5, steer: 0.2 }, at: at(5) },
    ], cfg('last'), T);
    assert.deepStrictEqual(r.axes, { throttle: -0.5, steer: 0.2 });
});

check('Mixed: half the average, half the freshest', () => {
    const r = mix([
        { who: 'a', role: 'viewer', axes: { throttle: 1 }, at: at(100) },
        { who: 'b', role: 'viewer', axes: { throttle: 0 }, at: at(5) },
    ], cfg('mixed'), T);
    assert.ok(Math.abs(r.axes.throttle - 0.25) < 1e-9, `(0.5 + 0) / 2 = 0.25, got ${r.axes.throttle}`);
});

check('the owner beats everything; a mod overrides the crowd; neither is held to the viewer cap', () => {
    const crowd = [{ who: 'a', role: 'viewer', axes: { throttle: 1 }, at: at(5) }, { who: 'b', role: 'viewer', axes: { throttle: 1 }, at: at(6) }];
    let r = mix([...crowd, { who: 'mod1', role: 'mod', axes: { throttle: -1 }, at: at(200) }], cfg('tug', { cap: 0.3 }), T);
    assert.deepStrictEqual([r.why, r.override, r.axes.throttle], ['override', 'mod1', -1]);
    r = mix([...crowd, { who: 'mod1', role: 'mod', axes: { throttle: -1 }, at: at(5) }, { who: 'owner', role: 'owner', axes: { throttle: 0.9, steer: 0 }, at: at(240) }], cfg('mixed', { cap: 0.3 }), T);
    assert.deepStrictEqual([r.why, r.override, r.axes.throttle], ['owner', 'owner', 0.9]);
    assert.deepStrictEqual(r.telemetry.override, { who: 'owner', role: 'owner' });
});

check('the viewer cap holds the crowd; the robot\'s ranges hold everyone', () => {
    const r = mix([{ who: 'a', role: 'viewer', axes: { throttle: 1, steer: -1 } , at: at(5) }], cfg('last', { cap: 0.4 }), T);
    assert.deepStrictEqual(r.axes, { throttle: 0.4, steer: -0.4 });
    const big = mix([{ who: 'o', role: 'owner', axes: { throttle: 50, steer: -9, warp: 3 }, at: at(1) }], cfg('mixed'), T);
    assert.deepStrictEqual(big.axes, { throttle: 1, steer: -1 }, 'an axis the robot does not have is dropped');
});

check('property: no crowd, style or input ever passes the cap or the ranges', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const roles = ['viewer', 'anon', 'viewer', 'mod', 'owner', 'operator'];
    for (let trial = 0; trial < 3000; trial++) {
        const style = STYLES[trial % STYLES.length];
        const cap = Math.round(rnd() * 100) / 100;
        const ranges = { throttle: [-(0.2 + rnd()), 0.2 + rnd()], steer: [-(0.1 + rnd() * 2), 0.1 + rnd() * 2] };
        const inputs = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, i) => ({
            who: `p${Math.floor(rnd() * 6)}`, role: roles[Math.floor(rnd() * (trial % 5 === 0 ? roles.length : 3))],
            axes: { throttle: (rnd() - 0.5) * 20, steer: rnd() < 0.1 ? NaN : (rnd() - 0.5) * 20 }, at: T - Math.floor(rnd() * 400),
        }));
        const r = mix(inputs, { style, cap, axes: ranges }, T);
        if (!r.axes) continue;
        const crowd = r.why !== 'owner' && r.why !== 'override';
        for (const [axis, [lo, hi]] of Object.entries(ranges)) {
            const v = r.axes[axis];
            assert.ok(Number.isFinite(v), `a number on ${axis}`);
            assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `${style}: ${axis} ${v} within [${lo}, ${hi}]`);
            if (crowd) assert.ok(v >= lo * cap - 1e-9 && v <= hi * cap + 1e-9, `${style}: the crowd's ${axis} ${v} within cap ${cap}`);
        }
    }
});

console.log(`crowd-mixers: ${n} checks; Tug-of-war, Last input wins, Mixed; the owner and mods override; never past the cap`);
