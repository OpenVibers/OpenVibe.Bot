'use strict';
/**
 * Crowd control, stage 1: the mixers (plan §H2, Maticus's mixer, 11-13; "the most modular configurable customizable
 * system", the owner). A mixer turns what many people are pressing into the one drive command a robot gets.
 *
 * Each mixer is a pure function with a manifest:
 *
 *   mix(inputs, config, now) → { axes, why, override, telemetry } | { axes: null, why: 'idle', telemetry }
 *
 *   inputs   [{ who, role, axes: { throttle: 0.4, steer: -1 }, at }]   who is a subject or a hashed anon id;
 *            role is owner | mod | operator | viewer | anon; at is a ms time stamp
 *   config   { style, windowMs (250), cap (0..1, the viewer speed cap), axes: { throttle: [min, max], … } }
 *
 * What every style shares, and no style can change:
 *   - an input counts while it is fresh (windowMs, 250 ms by default), and each person counts once: their latest;
 *   - the owner's input beats everything, then a mod's or an operator's while they are sending (the latest of them);
 *   - the crowd's result is held to the viewer speed cap (cap × each axis's own range), and every result is clamped
 *     to the robot's declared ranges. An override is clamped to the ranges, never to the viewer cap;
 *   - the robot's own safety (the owner's STOP, the commissioned ranges, per-command deadlines, auto-stop) sits below
 *     this, in Bot's gate and in Link: a mixer only proposes a command.
 *
 * The styles (more are a module away: Democracy, Queue, Captain, Teams, Weighted, Goal):
 *   tug    Tug-of-war: each axis is everyone's average, equal weight; opposite pulls cancel.
 *   last   Last input wins: the freshest input drives.
 *   mixed  Mixed (the default): half the average, half the freshest: it answers fast but a crowd still steers.
 *
 * Telemetry (for the Operators card and the stream overlay): how many are steering, the pull on each axis (the
 * average), the style, who overrides, and the busiest contributors in the window. Nothing here is wired into the live
 * control path yet: stage 2 does that behind a robot setting, off by default, checked with Maticus on the robot.
 */

const STYLES = Object.freeze(['tug', 'last', 'mixed']);
const OVERRIDE_ROLES = Object.freeze(['mod', 'operator']);
const DEFAULT_WINDOW_MS = 250;

const MANIFESTS = Object.freeze({
    tug: Object.freeze({ name: 'Tug-of-war', reads: 'every fresh input, one per person', settings: { windowMs: [50, 2000] } }),
    last: Object.freeze({ name: 'Last input wins', reads: 'the freshest input', settings: { windowMs: [50, 2000] } }),
    mixed: Object.freeze({ name: 'Mixed', reads: 'every fresh input and the freshest', settings: { windowMs: [50, 2000] } }),
});

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The config, checked: a known style, a window from 50 ms to 2 s, a cap from 0 to 1, ranges with min ≤ 0 ≤ max. */
function configOf(config = {}) {
    const style = STYLES.includes(config.style) ? config.style : 'mixed';
    const windowMs = clamp(num(config.windowMs) ?? DEFAULT_WINDOW_MS, 50, 2000);
    const cap = clamp(num(config.cap) ?? 1, 0, 1);
    const axes = {};
    for (const [axis, range] of Object.entries(config.axes || {})) {
        if (!Array.isArray(range) || range.length !== 2) continue;
        const lo = num(range[0]), hi = num(range[1]);
        if (lo == null || hi == null || lo > hi) continue;
        axes[axis] = [lo, hi];
    }
    return { style, windowMs, cap, axes };
}

/** Each person's latest fresh input, with the count of fresh inputs they sent in the window. */
function latestPerPerson(inputs, cfg, now) {
    const by = new Map();
    for (const i of Array.isArray(inputs) ? inputs : []) {
        if (!i || typeof i.who !== 'string' || !i.who || !i.axes || typeof i.axes !== 'object') continue;
        const at = num(i.at);
        if (at == null || at > now || now - at > cfg.windowMs) continue;
        const had = by.get(i.who);
        const count = (had ? had.count : 0) + 1;
        if (!had || at >= had.at) by.set(i.who, { who: i.who, role: String(i.role || 'viewer'), axes: i.axes, at, count });
        else had.count = count;
    }
    return [...by.values()];
}

/** An input's axes, as numbers within the robot's ranges (an axis the robot does not have is dropped; absent is 0). */
function axesOf(axes, cfg, scale = 1) {
    const out = {};
    for (const [axis, [lo, hi]] of Object.entries(cfg.axes)) {
        const v = num(axes && axes[axis]) ?? 0;
        out[axis] = clamp(clamp(v, lo, hi) * scale, lo * scale, hi * scale);
    }
    return out;
}

function average(people, cfg) {
    const sum = {};
    for (const axis of Object.keys(cfg.axes)) sum[axis] = 0;
    for (const p of people) { const a = axesOf(p.axes, cfg); for (const axis of Object.keys(sum)) sum[axis] += a[axis]; }
    const n = people.length || 1;
    for (const axis of Object.keys(sum)) sum[axis] /= n;
    return sum;
}

function telemetryOf(people, cfg, override) {
    const pull = average(people, cfg);
    const top = [...people].sort((a, b) => b.count - a.count || b.at - a.at).slice(0, 5).map((p) => ({ who: p.who, inputs: p.count }));
    return { people: people.length, pull, style: cfg.style, override: override ? { who: override.who, role: override.role } : null, top };
}

/**
 * The one command for this moment. Owner first, then the freshest mod or operator, then the crowd by its style,
 * held to the viewer cap.
 */
function mix(inputs, config, now = Date.now()) {
    const cfg = configOf(config);
    const people = latestPerPerson(inputs, cfg, now);
    if (!Object.keys(cfg.axes).length || !people.length) return { axes: null, why: 'idle', override: null, telemetry: telemetryOf([], cfg, null) };
    const freshest = (list) => list.reduce((a, b) => (b.at > a.at ? b : a));
    const owners = people.filter((p) => p.role === 'owner');
    if (owners.length) {
        const o = freshest(owners);
        return { axes: axesOf(o.axes, cfg), why: 'owner', override: o.who, telemetry: telemetryOf(people, cfg, o) };
    }
    const overriders = people.filter((p) => OVERRIDE_ROLES.includes(p.role));
    if (overriders.length) {
        const o = freshest(overriders);
        return { axes: axesOf(o.axes, cfg), why: 'override', override: o.who, telemetry: telemetryOf(people, cfg, o) };
    }
    const crowd = people;
    let out;
    if (cfg.style === 'last') out = axesOf(freshest(crowd).axes, cfg);
    else if (cfg.style === 'tug') out = average(crowd, cfg);
    else {
        const avg = average(crowd, cfg), last = axesOf(freshest(crowd).axes, cfg);
        out = {};
        for (const axis of Object.keys(cfg.axes)) out[axis] = (avg[axis] + last[axis]) / 2;
    }
    // The viewer speed cap: the crowd's result is held to cap × each axis's range.
    const capped = {};
    for (const [axis, [lo, hi]] of Object.entries(cfg.axes)) capped[axis] = clamp(out[axis], lo * cfg.cap, hi * cfg.cap);
    return { axes: capped, why: cfg.style, override: null, telemetry: telemetryOf(crowd, cfg, null) };
}

module.exports = { mix, configOf, latestPerPerson, STYLES, MANIFESTS, DEFAULT_WINDOW_MS };
