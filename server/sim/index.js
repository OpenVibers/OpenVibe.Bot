'use strict';

/**
 * The simulated device (ADR-043 decision 3): an in-process stand-in for a robot whose profile's driver is
 * `sim` (sim.rover), so the panel has something to drive before any hardware exists. It is attached to the
 * hub without a socket or a credential (hub.attachSim) and passes the same gate as real hardware: it answers
 * `hello`/`config`, sends heartbeats and telemetry, acks each command, mirrors the e-stop and stops by itself
 * at a motion command's `deadline_ms` unless a newer command arrived first (the Node's deadman).
 *
 *   attach(robotId)   start the robot's simulator if its profile is a `sim` one (idempotent; pass the profile if loaded) → true/false
 *   startAll()        every existing sim robot (boot)
 *   stop(robotId), stopAll(), running(robotId)
 *
 * No device row is written: the simulator's id is `dev_sim_<robot id>`, and a real device online for the same
 * robot takes precedence over it.
 *
 * The rover lives in the arena public/sim-world.js describes (the same module the browser draws its camera from):
 * walls and crates stop it, and its telemetry carries what a real rover's would (`sensors.distance_cm`,
 * `sensors.line`) plus `sim` ({ pose, drive, headlights, horn, bumped }) for the panel's simulated camera.
 */
const { getProfile } = require('../profiles');
const world = require('../../public/sim-world');

const isSimProfile = (profile) => !!(profile && profile.mapping && profile.mapping.driver === 'sim');
const BATTERY_FLOOR = 20;          // % the simulated pack never drains below
const DRAIN_PER_S = 0.05;          // % per second while moving
const EXISTS_EVERY = 20;           // telemetry frames between checks that the robot still exists
const PHYSICS_MS = 50;             // the rover moves at 20 Hz; telemetry goes out at the hub's sample rate

function createSimulator({ config, domain, hub, now = () => Date.now(), log = console }) {
    const sims = new Map();        // robot_id → sim
    const telemetryMs = Math.ceil(1000 / Math.max(1, config.control.telemetryHz)) + 20;   // just above the hub's sample window
    const heartbeatMs = Math.max(50, Math.floor(config.device.heartbeatMs / 2));
    const every = (ms, fn) => { const t = setInterval(() => { try { fn(); } catch (e) { log.warn(`[Bot] simulator: ${e.message}`); } }, ms); if (t.unref) t.unref(); return t; };

    function start(robot) {
        if (sims.has(robot.id)) return sims.get(robot.id);
        const device = { id: `dev_sim_${robot.id}`, robot_ids: [robot.id], kind: 'server', name: 'simulator' };
        const sim = { robotId: robot.id, device, link: null, timers: [], stopTimer: null, estop: !!robot.estop_latched, drive: {}, other: {}, battery: 100, pose: { ...world.START }, bumped: false, headlights: null, horn: null, hornUntil: 0, at: now(), sentAt: 0, ticks: 0 };
        sims.set(robot.id, sim);
        connect(sim);
        sim.timers.push(every(heartbeatMs, () => sim.link && sim.link.deliver({ type: 'heartbeat', t: now(), rtt_ms: 1 })));
        sim.timers.push(every(PHYSICS_MS, () => tick(sim)));
        return sim;
    }
    function connect(sim) {
        sim.link = hub.attachSim(sim.device, { onFrame: (f) => onFrame(sim, f), onClose: () => halt(sim) });
        if (sim.link) sim.link.ready.then(() => telemetry(sim));
    }

    function halt(sim) {
        if (sim.stopTimer) clearTimeout(sim.stopTimer);
        sim.stopTimer = null;
        for (const axis of Object.keys(sim.drive)) sim.drive[axis] = 0;
    }

    function onFrame(sim, f) {
        if (f.type === 'config') { sim.estop = !!f.estop_latched; if (sim.estop) halt(sim); return; }
        if (f.type === 'estop') { sim.estop = !!f.latched; if (sim.estop) halt(sim); return; }
        if (f.type !== 'command') return;
        const reply = (fields) => sim.link && sim.link.deliver({ id: f.id, ...fields });
        if (f.kind === 'halt') { halt(sim); return reply({ type: 'ack' }); }
        if (sim.estop) return reply({ type: 'nack', fault_code: 'estop_latched' });
        if (f.kind === 'drive') {
            sim.drive = { ...f.value };
            if (sim.stopTimer) clearTimeout(sim.stopTimer);
            // The deadman: no newer command by the deadline → stop, as the Node does.
            sim.stopTimer = Number.isFinite(f.deadline_ms) ? setTimeout(() => halt(sim), Math.max(0, f.deadline_ms - now())) : null;
            if (sim.stopTimer && sim.stopTimer.unref) sim.stopTimer.unref();
        } else if (f.kind === 'actuator' && f.value && f.value.name === 'headlights') {
            sim.headlights = f.value.value || null;
        } else if (f.kind === 'actuator' && f.value && f.value.name === 'horn') {
            // A tone sounds while it is held: the panel re-sends it, and its deadline ends it like a motion command's.
            sim.horn = f.value.value || null;
            sim.hornUntil = sim.horn && Number.isFinite(f.deadline_ms) ? f.deadline_ms : 0;
        } else {
            sim.other[f.kind] = f.value;
        }
        return reply({ type: 'ack' });
    }

    function telemetry(sim) {
        if (!sim.link) return;
        sim.link.deliver({
            type: 'telemetry',
            battery: { volts: Math.round((6.4 + (2 * sim.battery) / 100) * 100) / 100, percent: Math.round(sim.battery) },
            sensors: { distance_cm: world.distanceCm(sim.pose), line: world.line(sim.pose) }, rtt_ms: 1, drive: { ...sim.drive }, pose: { ...sim.pose },
            sim: { pose: { ...sim.pose }, drive: { ...sim.drive }, headlights: sim.headlights, horn: sim.horn, bumped: sim.bumped },
        });
    }

    function tick(sim) {
        const t = now();
        const dt = Math.max(0, (t - sim.at) / 1000);
        sim.at = t;
        // The arena's kinematics (public/sim-world.js); a stalled loop's long gap is cut into short steps so a bump is never jumped over.
        const moving = Object.values(sim.drive).some((v) => Number(v));
        if (moving) {
            let bumped = false;
            for (let left = Math.min(dt, 2); left > 0; left -= 0.05) {
                const r = world.step(sim.pose, sim.drive, Math.min(0.05, left));
                sim.pose = r.pose;
                if (r.bumped) { bumped = true; break; }
            }
            if (bumped && !sim.bumped) halt(sim);          // the bumper stops the wheels, as the deadman does
            sim.bumped = bumped;
            sim.battery = Math.max(BATTERY_FLOOR, sim.battery - DRAIN_PER_S * dt);
        } else sim.bumped = false;
        if (sim.hornUntil && t > sim.hornUntil) { sim.horn = null; sim.hornUntil = 0; }
        if (t - sim.sentAt < telemetryMs) return;
        sim.sentAt = t;
        sim.pose = { x: Math.round(sim.pose.x * 1000) / 1000, y: Math.round(sim.pose.y * 1000) / 1000, heading: Math.round(sim.pose.heading * 10) / 10 };
        // The hub marks a silent device offline for good; a simulator that fell behind (a stalled loop) reconnects.
        if (!hub.isOnline(sim.device.id)) connect(sim);
        else telemetry(sim);
        if (++sim.ticks % EXISTS_EVERY === 0) {
            domain.robots.get(sim.robotId).then((r) => { if (!r) stop(sim.robotId); }, () => {});
        }
    }

    function stop(robotId) {
        const sim = sims.get(robotId);
        if (!sim) return;
        sims.delete(robotId);
        for (const t of sim.timers) clearInterval(t);
        halt(sim);
        sim.link = null;
        hub.detachSim(sim.device.id);
    }

    /**
     * Start the robot's simulator when its profile's driver is `sim`; anything else is left alone. `profile`, when
     * the caller already loaded it, saves the read.
     */
    async function attach(robotOrId, profile) {
        const robot = typeof robotOrId === 'string' ? await domain.robots.get(robotOrId) : robotOrId;
        if (!robot) return false;
        if (sims.has(robot.id)) return true;
        if (profile === undefined) {
            const row = await getProfile(domain.db, robot.profile_id, robot.profile_version);
            profile = row && row.profile;
        }
        if (!isSimProfile(profile)) return false;
        start(robot);
        return true;
    }

    async function startAll() {
        const robots = await domain.db.many(`SELECT r.* FROM robots r JOIN robot_profiles p
            ON p.id = r.profile_id AND p.version = r.profile_version WHERE p.profile->'mapping'->>'driver' = 'sim'`);
        for (const robot of robots) await attach(robot);
        return robots.length;
    }

    function stopAll() { for (const id of [...sims.keys()]) stop(id); }

    return { attach, startAll, stop, stopAll, running: (robotId) => sims.has(robotId), isSimProfile };
}

module.exports = { createSimulator, isSimProfile };
