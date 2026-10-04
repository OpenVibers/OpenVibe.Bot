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
 */
const { listProfiles, getProfile } = require('../profiles');

const isSimProfile = (profile) => !!(profile && profile.mapping && profile.mapping.driver === 'sim');
const BATTERY_FLOOR = 20;          // % the simulated pack never drains below
const DRAIN_PER_S = 0.05;          // % per second while moving
const EXISTS_EVERY = 20;           // telemetry ticks between checks that the robot still exists

function createSimulator({ config, domain, hub, now = () => Date.now(), log = console }) {
    const sims = new Map();        // robot_id → sim
    const telemetryMs = Math.ceil(1000 / Math.max(1, config.control.telemetryHz)) + 20;   // just above the hub's sample window
    const heartbeatMs = Math.max(50, Math.floor(config.device.heartbeatMs / 2));
    const every = (ms, fn) => { const t = setInterval(() => { try { fn(); } catch (e) { log.warn(`[Bot] simulator: ${e.message}`); } }, ms); if (t.unref) t.unref(); return t; };

    function start(robot) {
        if (sims.has(robot.id)) return sims.get(robot.id);
        const device = { id: `dev_sim_${robot.id}`, robot_ids: [robot.id], kind: 'server', name: 'simulator' };
        const sim = { robotId: robot.id, device, link: null, timers: [], stopTimer: null, estop: !!robot.estop_latched, drive: {}, other: {}, battery: 100, pose: { x: 0, y: 0, heading: 0 }, at: now(), ticks: 0 };
        sims.set(robot.id, sim);
        connect(sim);
        sim.timers.push(every(heartbeatMs, () => sim.link && sim.link.deliver({ type: 'heartbeat', t: now(), rtt_ms: 1 })));
        sim.timers.push(every(telemetryMs, () => tick(sim)));
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
            sensors: {}, rtt_ms: 1, drive: { ...sim.drive }, pose: { ...sim.pose },
        });
    }

    function tick(sim) {
        const t = now();
        const dt = Math.max(0, (t - sim.at) / 1000);
        sim.at = t;
        // A simple kinematic model: forward speed from throttle (or y), turn rate from steer (or rotation).
        const speed = Number(sim.drive.throttle != null ? sim.drive.throttle : sim.drive.y) || 0;
        const turn = Number(sim.drive.steer != null ? sim.drive.steer : sim.drive.rotation) || 0;
        const strafe = Number(sim.drive.x) || 0;
        sim.pose.heading = (sim.pose.heading + turn * 90 * dt + 360) % 360;
        const rad = (sim.pose.heading * Math.PI) / 180;
        sim.pose.x = Math.round((sim.pose.x + (speed * Math.sin(rad) + strafe * Math.cos(rad)) * 0.5 * dt) * 1000) / 1000;
        sim.pose.y = Math.round((sim.pose.y + (speed * Math.cos(rad) - strafe * Math.sin(rad)) * 0.5 * dt) * 1000) / 1000;
        if (speed || turn || strafe) sim.battery = Math.max(BATTERY_FLOOR, sim.battery - DRAIN_PER_S * dt);
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
        const ids = (await listProfiles(domain.db)).filter((r) => isSimProfile(r.profile)).map((r) => r.id);
        if (!ids.length) return 0;
        const robots = await domain.db.many('SELECT * FROM robots WHERE profile_id = ANY($1)', [ids]);
        for (const robot of robots) await attach(robot);
        return robots.length;
    }

    function stopAll() { for (const id of [...sims.keys()]) stop(id); }

    return { attach, startAll, stop, stopAll, running: (robotId) => sims.has(robotId), isSimProfile };
}

module.exports = { createSimulator, isSimProfile };
