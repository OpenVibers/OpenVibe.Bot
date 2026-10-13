'use strict';

/**
 * /try: a simulated rover that lives in this page, so anyone can drive the real panel with no account and no
 * hardware. It stands in for both ends of a robot's link: `window.OVBotLocalSocket` answers the panel's /control
 * frames (public/panel.js uses it when the page says data-transport="local"), and the rover runs on the shared
 * arena's kinematics (public/sim-world.js) at the page's frame rate.
 *
 * It keeps the gate's rules that a driver would feel: only the profile's command kinds; drive axes and actuator
 * values shaped to the profile's ranges (as server/domain does); a latched e-stop that refuses everything but halt
 * until it is cleared; and the device's deadman: a motion command lapses max_command_ms after it was sent unless
 * a newer one arrives (the panel re-sends a held control every 150 ms). Bumping into something stops the wheels.
 *
 * window.OVSimLocal exposes the pose, the headlights and the horn to the camera view (public/sim-view.js).
 */
(() => {
    const W = window.OVSimWorld;
    const main = document.getElementById('panel');
    const source = document.getElementById('try-profile');
    if (!W || !main || main.dataset.transport !== 'local' || !source) return;
    const profile = JSON.parse(source.textContent);
    const commands = profile.commands || {};
    const limits = profile.limits || {};
    const DEADLINE_MS = limits.max_command_ms || 300;
    const ALLOWED = [...Object.keys(commands).filter((k) => k !== 'halt'), 'halt'];
    const TELEMETRY_MS = 200;
    const BATTERY_FLOOR = 20;

    const rover = {
        pose: { ...W.START }, drive: {}, deadline: 0, headlights: null, horn: null, hornUntil: 0,
        battery: 100, estop: false, bumped: false,
    };
    const clamp = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };
    const noteHz = (note) => {
        const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(note));
        if (!m) return null;
        const semis = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
        return 440 * 2 ** ((12 * (Number(m[3]) + 1) + semis - 69) / 12);
    };

    /** The value the device gets, or a refusal reason (server/domain buildValue, for the kinds this profile has). */
    function shape(kind, value) {
        const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        if (kind === 'halt') return { value: {} };
        if (kind === 'drive') {
            const out = {};
            for (const [axis, [lo, hi]] of Object.entries(commands.drive.axes)) out[axis] = clamp(v[axis], lo, hi);
            return { value: out };
        }
        if (kind === 'actuator') {
            const spec = commands.actuator.names[v.name];
            if (!spec) return { refused: 'this robot has no such actuator' };
            const x = v.value;
            if (spec.type === 'rgb') return { value: { name: v.name, value: x ? { r: Math.round(clamp(x.r, 0, 255)), g: Math.round(clamp(x.g, 0, 255)), b: Math.round(clamp(x.b, 0, 255)) } : null } };
            if (spec.type === 'tone') {
                if (!x) return { value: { name: v.name, value: null } };
                const hz = x.note != null ? noteHz(x.note) : Number(x.hz);
                if (!Number.isFinite(hz)) return { refused: `${v.name} takes {note} or {hz}` };
                return { value: { name: v.name, value: hz === 0 ? null : { hz: Math.round(clamp(hz, spec.hz[0], spec.hz[1])) } } };
            }
            if (spec.type === 'number') return { value: { name: v.name, value: clamp(x, spec.range[0], spec.range[1]) } };
            return { value: { name: v.name, value: !!x } };
        }
        return { refused: `${kind} is not something this robot does` };
    }

    function halt() { rover.drive = {}; rover.deadline = 0; }
    function apply(kind, value) {
        const now = performance.now();
        if (kind === 'halt') { halt(); return; }
        if (kind === 'drive') { rover.drive = value; rover.deadline = now + DEADLINE_MS; return; }
        if (kind === 'actuator') {
            if (value.name === 'headlights') rover.headlights = value.value;
            else if (value.name === 'horn') { rover.horn = value.value; rover.hornUntil = value.value ? now + DEADLINE_MS : 0; }
        }
    }

    function state() {
        return {
            robot_id: main.dataset.robotId, online: true,
            estop: { latched: rover.estop, by: null, at: null },
            latency_ms: 12, battery: rover.battery / 100,
            telemetry: {
                battery: { percent: Math.round(rover.battery) },
                sensors: { distance_cm: W.distanceCm(rover.pose), line: W.line(rover.pose) },
                sim: { pose: { ...rover.pose }, drive: { ...rover.drive }, headlights: rover.headlights, horn: rover.horn, bumped: rover.bumped },
            },
            status: null, device_estop: null, queue: null,
        };
    }

    // ── The rover's clock ─────────────────────────────────────────────────────────────────────────────
    let last = performance.now();
    function tick() {
        const now = performance.now();
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        if (rover.deadline && now > rover.deadline) halt();               // the deadman
        if (rover.hornUntil && now > rover.hornUntil) { rover.horn = null; rover.hornUntil = 0; }
        const moving = Object.values(rover.drive).some((x) => x);
        if (moving && !rover.estop) {
            const r = W.step(rover.pose, rover.drive, dt);
            rover.pose = r.pose;
            if (r.bumped && !rover.bumped) halt();                        // the bumper stops the wheels
            rover.bumped = r.bumped;
            rover.battery = Math.max(BATTERY_FLOOR, rover.battery - 0.25 * dt);
        } else rover.bumped = false;
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    window.OVSimLocal = { pose: () => rover.pose, headlights: () => rover.headlights, horn: () => rover.horn };

    // ── The panel's socket ────────────────────────────────────────────────────────────────────────────
    const sockets = new Set();
    class LocalSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.onopen = null; this.onmessage = null; this.onclose = null;
            setTimeout(() => {
                if (this.readyState !== 0) return;
                this.readyState = 1;
                sockets.add(this);
                if (this.onopen) this.onopen({});
            }, 40);
        }
        deliver(frame, delay = 0) {
            const out = () => { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify({ v: 1, ...frame }) }); };
            if (delay) setTimeout(out, delay); else out();
        }
        send(raw) {
            if (this.readyState !== 1) return;
            let m; try { m = JSON.parse(raw); } catch { return; }
            if (m.type === 'join') {
                this.joined = true;
                this.deliver({ type: 'joined', robot_id: m.robot_id, role: 'owner', allowed_commands: ALLOWED, state: state() }, 20);
                return;
            }
            if (!this.joined) return this.deliver({ type: 'error', code: 'bot.not_joined', detail: 'join first' });
            if (m.type === 'estop') { rover.estop = true; halt(); rover.horn = null; return broadcast(); }
            if (m.type === 'estop_clear') { rover.estop = false; return broadcast(); }
            if (m.type !== 'command') return;
            const id = String(m.id || '');
            const kind = String(m.kind || '');
            const reply = (fields) => this.deliver({ type: 'command_result', id, ...fields }, 10 + Math.round(Math.random() * 14));
            if (!ALLOWED.includes(kind)) return reply({ result: 'refused', code: 'bot.command_not_allowed', reason: `${kind} is not something this robot does` });
            if (rover.estop && kind !== 'halt') return reply({ result: 'refused', code: 'bot.estopped', reason: 'The e-stop is latched. Clear it to drive again.' });
            const shaped = shape(kind, m.value);
            if (shaped.refused) return reply({ result: 'refused', code: 'bot.invalid_input', reason: shaped.refused });
            apply(kind, shaped.value);
            return reply({ result: 'ack' });
        }
        close() {
            if (this.readyState === 3) return;
            this.readyState = 3;
            sockets.delete(this);
            if (this.onclose) this.onclose({ code: 1000 });
        }
        addEventListener() { /* the panel's /control socket uses on* handlers only */ }
        removeEventListener() {}
    }
    LocalSocket.CONNECTING = 0; LocalSocket.OPEN = 1; LocalSocket.CLOSING = 2; LocalSocket.CLOSED = 3;
    function broadcast() { const s = state(); for (const ws of sockets) if (ws.joined) ws.deliver({ type: 'robot_state', state: s }); }
    setInterval(() => { if (!document.hidden) broadcast(); }, TELEMETRY_MS);
    window.OVBotLocalSocket = LocalSocket;

    // "Back to the start": put the rover where it began (a page-only control, not a robot command).
    for (const b of document.querySelectorAll('[data-try-reset]')) {
        b.addEventListener('click', () => { halt(); rover.pose = { ...W.START }; rover.bumped = false; rover.battery = 100; broadcast(); });
    }
})();
