'use strict';

/**
 * Robot routines (plan T15 "schedules and automations"): an owner writes a robot's steps in plain lines, Bot runs them
 * on demand, on a schedule, or when the robot comes online. Every step passes the same gate as a person's command, as
 * the robot's owner (hub.operatorCommand): the robot's limits, cooldowns and e-stop apply, and the audit has each one.
 *
 *   parseSteps(text, profile) → { steps } or throws BotError 422 with the line that is wrong. One step per line:
 *     forward [seconds] [speed]     back [s] [speed]     left [s] [speed]     right [s] [speed]     stop
 *     wait <seconds>                say <text>           face <name>          show <text>          press <button>
 *     <actuator> <value> [seconds]  (number, #rrggbb or off, a note like A4 or off, on/off; held for the seconds)
 *     pan|tilt|zoom <value> [seconds]
 *   parseTrigger({ type, every, at, days }) → { type: 'manual' } | { type: 'schedule', every?|at+days } | { type: 'online' }
 *   nextRun(trigger, from) → Date | null
 *   createRoutines({ db, domain, hub, now, log }) → { list, get, create, remove, run, tick, onOnline, stop }
 *
 * A held step (a motion or a tone) is re-sent every HOLD_MS so the device's deadman never stops it early, and a zero
 * drive ends it. A refused or failed command stops the routine there (an e-stop, the robot going offline, a cooldown
 * the owner set too long); the reason is kept in last_result. One routine runs per robot at a time.
 */
const { BotError, prefixedId, iso, text } = require('./util');

const HOLD_MS = 150;
const MAX_STEPS = 60;
const MAX_STEP_S = 60;
const MAX_TOTAL_S = 600;
const MIN_EVERY_MIN = 5;
const TICK_MS = 30000;

const fail = (detail) => { throw new BotError(422, 'bot.invalid_routine', detail); };
const num = (s, what, lo, hi) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n < lo || n > hi) fail(`${what} must be a number from ${lo} to ${hi}`);
    return n;
};

/** The drive axes for forward/back and left/right on this profile: [forward axis, turn axis]. */
function driveAxes(profile) {
    const axes = (profile.commands && profile.commands.drive && profile.commands.drive.axes) || null;
    if (!axes) return null;
    const fwd = ['throttle', 'y'].find((a) => axes[a]);
    const turn = ['steer', 'rotation', 'x'].find((a) => axes[a]);
    return { fwd, turn };
}

function parseSteps(source, profile) {
    const commands = (profile && profile.commands) || {};
    const lines = String(source || '').split('\n');
    const steps = [];
    let total = 0;
    lines.forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;   // a line starting with # is a note (colours keep their #)
        const at = `line ${i + 1} ("${line.slice(0, 40)}")`;
        const [word, ...rest] = line.split(/\s+/);
        const w = word.toLowerCase();
        const secs = (v, d) => (v == null ? d : num(v, `${at}: the seconds`, 0.05, MAX_STEP_S));
        const step = (() => {
                if (['forward', 'back', 'backward', 'left', 'right'].includes(w)) {
                    const d = driveAxes(profile);
                    if (!d) fail(`${at}: this robot does not drive`);
                    const turning = w === 'left' || w === 'right';
                    const axis = turning ? d.turn : d.fwd;
                    if (!axis) fail(`${at}: this robot cannot ${turning ? 'turn' : 'drive forward'}`);
                    const speed = rest[1] == null ? (turning ? 0.7 : 0.6) : num(rest[1], `${at}: the speed`, 0.05, 1);
                    const sign = w === 'back' || w === 'backward' || w === 'left' ? -1 : 1;
                    return { kind: 'drive', value: { [axis]: Math.round(sign * speed * 100) / 100 }, seconds: secs(rest[0], 1), hold: true };
                }
                if (w === 'stop') { if (!commands.drive) fail(`${at}: this robot does not drive`); return { kind: 'drive', value: {}, seconds: 0 }; }
                if (w === 'wait') return { kind: 'wait', seconds: secs(rest[0], 1) };
                if (w === 'say') {
                    if (!commands.say) fail(`${at}: this robot does not speak`);
                    const t = rest.join(' ');
                    if (!t) fail(`${at}: say what?`);
                    return { kind: 'say', value: { text: t.slice(0, (commands.say.max_chars || 200)) }, seconds: 0 };
                }
                if (w === 'face' || w === 'show') {
                    const d = commands.display;
                    if (!d) fail(`${at}: this robot has no display`);
                    if (w === 'face') {
                        const f = String(rest[0] || '').toLowerCase();
                        if (!(d.faces || []).includes(f)) fail(`${at}: faces are ${(d.faces || []).join(', ') || 'not shown here'}`);
                        return { kind: 'display', value: { face: f }, seconds: 0 };
                    }
                    if (!d.modes.includes('text')) fail(`${at}: this display shows no text`);
                    return { kind: 'display', value: { text: rest.join(' ').slice(0, d.max_chars || 200) }, seconds: 0 };
                }
                if (w === 'press') {
                    const names = (commands.button && commands.button.names) || {};
                    if (!names[rest[0]]) fail(`${at}: this robot has no button ${rest[0] || ''}`.trim());
                    return names[rest[0]].hold
                        ? { kind: 'button', value: { name: rest[0], state: 'down' }, seconds: secs(rest[1], 0.5), hold: true, release: { name: rest[0], state: 'up' } }
                        : { kind: 'button', value: { name: rest[0] }, seconds: 0 };
                }
                if (['pan', 'tilt', 'zoom'].includes(w) && commands.ptz && commands.ptz.axes[w]) {
                    return { kind: 'ptz', value: { [w]: num(rest[0], `${at}: the ${w}`, -1, 1) }, seconds: secs(rest[1], 0.5), hold: true, release: { [w]: 0 } };
                }
                const act = commands.actuator && commands.actuator.names[w];
                if (act) {
                    const v = String(rest[0] == null ? '' : rest[0]);
                    let value;
                    if (act.type === 'number') value = num(v, `${at}: the value`, act.range[0], act.range[1]);
                    else if (act.type === 'bool') { if (!['on', 'off'].includes(v)) fail(`${at}: on or off`); value = v === 'on'; }
                    else if (act.type === 'rgb') {
                        if (v === 'off') value = null;
                        else { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v); if (!m) fail(`${at}: a colour like #ff8800, or off`); value = { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }; }
                    } else {
                        if (v === 'off') value = null;
                        else if (/^[A-Ga-g][#b]?-?\d$/.test(v)) value = { note: v[0].toUpperCase() + v.slice(1) };
                        else value = { hz: num(v, `${at}: a note like A4 or a frequency`, act.hz[0], act.hz[1]) };
                        const s = secs(rest[1], 0.5);
                        return { kind: 'actuator', value: { name: w, value }, seconds: value ? s : 0, hold: !!value, release: value ? { name: w, value: null } : null };
                    }
                    return { kind: 'actuator', value: { name: w, value }, seconds: 0 };
                }
                fail(`${at}: "${word}" is not a step this robot knows`);
                return null;
        })();
        if (step.kind !== 'wait' && !commands[step.kind]) fail(`${at}: this robot does not take ${step.kind} commands`);
        total += step.seconds || 0;
        steps.push(step);
    });
    if (!steps.length) fail('write at least one step, one per line');
    if (steps.length > MAX_STEPS) fail(`at most ${MAX_STEPS} steps`);
    if (total > MAX_TOTAL_S) fail(`a routine runs at most ${MAX_TOTAL_S / 60} minutes`);
    return { steps };
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
function parseTrigger(t = {}) {
    const type = String(t.type || 'manual');
    if (type === 'manual' || type === 'online') return { type };
    if (type !== 'schedule') throw new BotError(422, 'bot.invalid_routine', 'the trigger is manual, schedule or online');
    if (t.every != null && t.every !== '') {
        const every = Number(t.every);
        if (!Number.isInteger(every) || every < MIN_EVERY_MIN || every > 7 * 24 * 60) throw new BotError(422, 'bot.invalid_routine', `every is a whole number of minutes, at least ${MIN_EVERY_MIN}`);
        return { type, every };
    }
    if (!TIME.test(String(t.at || ''))) throw new BotError(422, 'bot.invalid_routine', 'a schedule runs every N minutes, or at a time like 09:30 (UTC)');
    const days = Array.isArray(t.days) && t.days.length ? [...new Set(t.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [0, 1, 2, 3, 4, 5, 6];
    if (!days.length) throw new BotError(422, 'bot.invalid_routine', 'choose at least one day');
    return { type, at: String(t.at), days };
}

/** When a schedule next runs after `from` (a Date), or null for a trigger that is not a schedule. */
function nextRun(trigger, from) {
    if (!trigger || trigger.type !== 'schedule') return null;
    if (trigger.every) return new Date(from.getTime() + trigger.every * 60000);
    const [h, m] = trigger.at.split(':').map(Number);
    for (let i = 0; i <= 7; i++) {
        const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + i, h, m));
        if (d > from && trigger.days.includes(d.getUTCDay())) return d;
    }
    return null;
}

function describeTrigger(t) {
    if (!t || t.type === 'manual') return 'When you run it';
    if (t.type === 'online') return 'Each time it comes online';
    if (t.every) return `Every ${t.every} minutes`;
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `At ${t.at} UTC${t.days.length === 7 ? ' daily' : ` on ${t.days.map((d) => names[d]).join(', ')}`}`;
}

function createRoutines({ db, domain, hub, now = () => Date.now(), log = console, tickMs = TICK_MS }) {
    const running = new Map();   // robot id → { routineId, stop: bool }
    const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
    let timer = null;

    const list = (robotId) => db.many('SELECT * FROM robot_routines WHERE robot_id = $1 ORDER BY created_at', [robotId]);
    const get = (id) => db.maybe('SELECT * FROM robot_routines WHERE id = $1', [id]);

    async function create(robot, person, { name, source, trigger, enabled = true }, profile) {
        const cleanName = text(name, 'name', 60);
        if (!cleanName) throw new BotError(422, 'bot.invalid_routine', 'name the routine');
        const { steps } = parseSteps(source, profile);
        const tr = parseTrigger(trigger);
        const id = prefixedId('rtn', now());
        const at = new Date(now());
        await db.query(`INSERT INTO robot_routines (id, robot_id, name, source, steps, trigger, enabled, next_run_at, created_by, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $10)`,
        [id, robot.id, cleanName, String(source).slice(0, 4000), JSON.stringify(steps), JSON.stringify(tr), !!enabled, enabled ? (nextRun(tr, at) ? iso(nextRun(tr, at).getTime()) : null) : null, person.subject, iso(at.getTime())]);
        return get(id);
    }

    async function remove(robotId, id) {
        const r = running.get(robotId);
        if (r && r.routineId === id) r.stop = true;
        return (await db.exec('DELETE FROM robot_routines WHERE id = $1 AND robot_id = $2', [id, robotId])) > 0;
    }

    async function finish(id, result) {
        await db.query('UPDATE robot_routines SET last_result = $2, updated_at = $3 WHERE id = $1', [id, String(result).slice(0, 200), iso(now())]);
    }

    /** Send one command as the owner; resolves true when the device ran it, else false with the reason kept. */
    async function send(robot, step, value, ms) {
        const principal = { kind: 'user', subject: robot.owner_subject, role: 'user', via: 'routine' };
        const r = await hub.operatorCommand(robot.id, principal, robot.owner_subject, { id: prefixedId('rcmd', now()), kind: step.kind, value, ms });
        if (r.result === 'ack') return { ok: true };
        return { ok: false, why: r.reason || r.code || r.result };
    }

    /** Run a routine now (in the background); false when one is already running on the robot. */
    async function run(id, { reason = 'run' } = {}) {
        const routine = await get(id);
        if (!routine) throw new BotError(404, 'bot.routine_not_found', 'no such routine');
        if (running.has(routine.robot_id)) return false;
        const robot = await domain.robots.get(routine.robot_id);
        if (!robot) return false;
        const state = { routineId: id, stop: false };
        running.set(robot.id, state);
        await db.query('UPDATE robot_routines SET last_run_at = $2, last_result = $3, updated_at = $2 WHERE id = $1', [id, iso(now()), 'running']);
        (async () => {
            const steps = typeof routine.steps === 'string' ? JSON.parse(routine.steps) : routine.steps;
            let result = 'done';
            try {
                for (const step of steps) {
                    if (state.stop) { result = 'stopped: removed'; break; }
                    if (step.kind === 'wait') { await sleep(step.seconds * 1000); continue; }
                    if (!step.hold) {
                        const r = await send(robot, step, step.value, null);
                        if (!r.ok) { result = `stopped: ${r.why}`; break; }
                        continue;
                    }
                    // Held: re-sent within the deadman window until the step's time is up, then released.
                    const end = now() + step.seconds * 1000;
                    let ok = true;
                    while (now() < end && !state.stop) {
                        const r = await send(robot, step, step.value, Math.min(300, end - now() + HOLD_MS));
                        if (!r.ok) { result = `stopped: ${r.why}`; ok = false; break; }
                        await sleep(Math.min(HOLD_MS, Math.max(0, end - now())));
                    }
                    const release = step.kind === 'drive' ? {} : step.release;
                    if (release) await send(robot, step, release, null).catch(() => {});
                    if (!ok) break;
                }
            } catch (e) {
                result = `stopped: ${e.message}`;
                log.warn(`[Bot] routine ${id}: ${e.message}`);
            } finally {
                running.delete(robot.id);
                await finish(id, result).catch(() => {});
            }
        })();
        log.log && log.log(`[Bot] routine ${id} on ${robot.id} started (${reason})`);
        return true;
    }

    /** The scheduler: each due, enabled scheduled routine runs (if its robot is free) and gets its next time. */
    async function tick() {
        const due = await db.many("SELECT * FROM robot_routines WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at LIMIT 50", [iso(now())]);
        for (const r of due) {
            const trigger = typeof r.trigger === 'string' ? JSON.parse(r.trigger) : r.trigger;
            const next = nextRun(trigger, new Date(now()));
            await db.query('UPDATE robot_routines SET next_run_at = $2 WHERE id = $1', [r.id, next ? iso(next.getTime()) : null]);
            await run(r.id, { reason: 'schedule' }).catch((e) => log.warn(`[Bot] routine ${r.id}: ${e.message}`));
        }
        return due.length;
    }

    /** A robot came online: its "each time it comes online" routines run (the first enabled one, one at a time). */
    async function onOnline(robotId) {
        const rows = await db.many("SELECT id FROM robot_routines WHERE robot_id = $1 AND enabled AND trigger->>'type' = 'online' ORDER BY created_at", [robotId]);
        for (const r of rows) if (await run(r.id, { reason: 'online' }).catch(() => false)) break;
    }

    function start() {
        if (timer || !tickMs) return;
        timer = setInterval(() => { tick().catch((e) => log.warn(`[Bot] routines: ${e.message}`)); }, tickMs);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; for (const s of running.values()) s.stop = true; }

    return { list, get, create, remove, run, tick, onOnline, start, stop, isRunning: (robotId) => running.has(robotId), describeTrigger };
}

module.exports = { createRoutines, parseSteps, parseTrigger, nextRun, describeTrigger, HOLD_MS };
