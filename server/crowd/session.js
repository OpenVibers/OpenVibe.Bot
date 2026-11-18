'use strict';
/**
 * Crowd control, stage 2: the live part (plan §H2). A robot whose access_policy is `crowd` is driven by everyone in its
 * panel at once: each person's drive is an input here, never a command of its own; every tick (250 ms) the robot's
 * mixer (server/crowd/mixers.js) turns the fresh inputs into one drive, which realtime.js sends through the same gate
 * as any operator's command (domain.control.prepare as the `crowd` role: the owner's limits, cooldown and sole control
 * still apply), then to the device with its own deadline.
 *
 *   createCrowd({ send, configFor, onTick, now, setTimer, clearTimer, intervalMs })
 *     input(robotId, { who, axes })   one person's latest drive (who: a subject, or a hashed anon id); → accepted
 *     pause(robotId, ms, role)        the owner, a Mod or an Operator drove directly: the crowd waits (default 1 s)
 *   onTick(robotId, { people, pull, style, override, paused }) after every tick that holds people, paused or not
 *     (realtime.js sends it as bot.crowd-tick@1, at most twice a second)
 *     telemetry(robotId)              the last tick's telemetry, or null
 *     forget(robotId) / stop()        drop a robot's inputs / every timer
 *
 * A ticker runs only while a robot holds a fresh input; an idle crowd sends nothing, so the device's own deadline and
 * Bot's movement lease stop the robot. Nothing here talks to a socket or the database: realtime.js passes `send`.
 */
const { mix, configOf } = require('./mixers');

const TICK_MS = 250;
const PAUSE_MS = 1000;
const MAX_PEOPLE = 500;          // one robot's crowd: inputs past this are refused until a slot frees
const MAX_AXES = 8;

function cleanAxes(axes) {
    if (!axes || typeof axes !== 'object' || Array.isArray(axes)) return null;
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(axes)) {
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(k) || typeof v !== 'number' || !Number.isFinite(v)) continue;
        out[k] = Math.max(-1, Math.min(1, v));
        if (++n >= MAX_AXES) break;
    }
    return n ? out : null;
}

function createCrowd({ send, configFor, onTick = null, now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval, intervalMs = TICK_MS, log = console } = {}) {
    if (typeof send !== 'function' || typeof configFor !== 'function') throw new TypeError('createCrowd needs send(robotId, axes, telemetry) and configFor(robotId)');
    const robots = new Map();   // robotId → { people: Map(who → input), timer, busy, telemetry }
    // robotId → { until, role }: when the crowd waits to, and for whom. Its own map: the owner may drive before anyone
    // in the crowd has steered.
    const pauses = new Map();

    function slot(robotId) {
        let r = robots.get(robotId);
        if (!r) { r = { people: new Map(), timer: null, busy: false, telemetry: null }; robots.set(robotId, r); }
        return r;
    }

    function stopTimer(r) { if (r.timer) { clearTimer(r.timer); r.timer = null; } }

    async function tick(robotId) {
        const r = robots.get(robotId);
        if (!r || r.busy) return;
        r.busy = true;
        try {
            const cfg = configOf(await configFor(robotId));
            const t = now();
            // Inputs past four windows are gone; with none left the ticker stops (and the robot with its deadline).
            for (const [who, input] of r.people) if (t - input.at > cfg.windowMs * 4) r.people.delete(who);
            if (!r.people.size) { stopTimer(r); robots.delete(robotId); return; }
            const held = pauses.get(robotId) || null;
            const paused = !!(held && t < held.until);
            if (held && !paused) pauses.delete(robotId);
            // An input counts for its window plus one tick: the tick that follows it always sees it, however the
            // timer and the database wait line up (a window equal to the tick would otherwise miss a single press).
            const out = mix([...r.people.values()], { ...cfg, windowMs: Math.min(2000, cfg.windowMs + intervalMs) }, t);
            r.telemetry = out.telemetry || null;
            if (onTick && r.telemetry) {
                try { onTick(robotId, { people: r.telemetry.people, pull: r.telemetry.pull, style: r.telemetry.style, override: paused ? { role: held.role } : null, paused }); } catch { /* a listener never stops the crowd */ }
            }
            if (!paused && out.axes) await send(robotId, out.axes, out.telemetry);
        } catch (err) {
            if (log && log.warn) log.warn(`[crowd] ${robotId}: ${err && err.message}`);
        } finally {
            r.busy = false;
        }
    }

    function input(robotId, { who, axes, role = 'viewer' } = {}) {
        const clean = cleanAxes(axes);
        if (!robotId || !who || !clean) return { accepted: false, code: 'bot.invalid_input', reason: 'a crowd input is a drive with numeric axes' };
        const r = slot(robotId);
        if (!r.people.has(who) && r.people.size >= MAX_PEOPLE) return { accepted: false, code: 'bot.crowd_full', reason: 'the crowd is full right now' };
        r.people.set(who, { who, role, axes: clean, at: now() });
        if (!r.timer) {
            // The first input of a quiet crowd moves the robot now, not a tick later; the ticker carries on from there.
            r.timer = setTimer(() => { tick(robotId); }, intervalMs);
            if (r.timer && r.timer.unref) r.timer.unref();
            setImmediate(() => { tick(robotId); });
        }
        return { accepted: true, steering: r.people.size };
    }

    function pause(robotId, ms = PAUSE_MS, role = 'owner') {
        const t = now();
        if (pauses.size > 1000) for (const [id, held] of pauses) if (held.until <= t) pauses.delete(id);
        const had = pauses.get(robotId);
        // The owner outranks a Mod or an Operator for the length of the wait; the later end wins.
        const keep = had && had.until > t && had.role === 'owner' && role !== 'owner';
        pauses.set(robotId, { until: Math.max(had ? had.until : 0, t + ms), role: keep ? had.role : role });
    }

    function forget(robotId) {
        const r = robots.get(robotId);
        if (r) { stopTimer(r); robots.delete(robotId); }
        pauses.delete(robotId);
    }

    function stop() { for (const id of [...robots.keys()]) forget(id); }

    return { input, pause, forget, stop, tick, telemetry: (robotId) => (robots.get(robotId) || {}).telemetry || null, size: (robotId) => ((robots.get(robotId) || {}).people || new Map()).size };
}

module.exports = { createCrowd, cleanAxes, TICK_MS, PAUSE_MS, MAX_PEOPLE };
