'use strict';

/**
 * The panel client (plain ES, no build step, no framework). The server rendered every widget from the robot's
 * profile (server/web/render.js); this wires them to wss://<host>/control with the session cookie: `join`,
 * paint the robot's state, and send each command with a fresh id (an id is an idempotency key, so a re-send
 * with the same one would never reach the robot).
 *
 * A held control (data-hold, data-tone) is re-sent every holdResendMs while it is held, and releasing it sends
 * the stop (a zero drive, a zero axis, a silent tone) at once: the device's deadline is the last line of
 * defence, never the way a panel stops a robot. Losing the socket, the window or the page releases everything.
 *
 * Also on the pairing page: [data-copy] copies the installer command.
 */
(() => {
    for (const b of document.querySelectorAll('[data-copy]')) {
        b.addEventListener('click', () => {
            const src = document.querySelector('[data-copy-source]');
            if (src && navigator.clipboard) navigator.clipboard.writeText(src.textContent).then(() => { b.dataset.copied = 'true'; }, () => {});
        });
    }

    const main = document.getElementById('panel');
    if (!main) return;
    const ROBOT_ID = main.dataset.robotId;
    const HOLD_MS = Number(main.dataset.holdMs) || 150;
    let allowed = JSON.parse(main.dataset.allowed || '[]');
    let ws = null;
    let joined = false;
    let retry = 0;
    let gone = false;          // refused for good (no access): no reconnect

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
    const kindOf = (el) => { const s = el.closest('[data-command]'); return s ? JSON.parse(s.dataset.command).kind : null; };
    const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    function notice(text) {
        const n = $('[data-notice]');
        if (!n) return;
        n.textContent = text || '';
        n.hidden = !text;
    }
    function raw(frame) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify({ v: 1, ...frame }));
        return true;
    }
    function send(kind, value) {
        if (!joined || !allowed.includes(kind)) return false;
        return raw({ type: 'command', id: newId(), kind, value });
    }

    // ── Held controls ─────────────────────────────────────────────────────────────────────────────
    // kind → { els: Map<element, value>, timer }: several held axes of one kind are sent as one value.
    const holds = new Map();
    const combined = (h) => Object.assign({}, ...h.els.values());
    function pressAxis(el) {
        const kind = kindOf(el);
        if (!kind || el.disabled) return;
        let h = holds.get(kind);
        if (!h) { h = { els: new Map(), timer: null }; holds.set(kind, h); }
        if (h.els.has(el)) return;
        h.els.set(el, JSON.parse(el.dataset.hold));
        el.classList.add('held');
        send(kind, combined(h));
        if (!h.timer) h.timer = setInterval(() => send(kind, combined(h)), HOLD_MS);
    }
    function releaseAxis(el) {
        const kind = kindOf(el);
        const h = kind && holds.get(kind);
        if (!h || !h.els.has(el)) return;
        const released = h.els.get(el);
        h.els.delete(el);
        el.classList.remove('held');
        const zero = {};
        for (const axis of Object.keys(released)) zero[axis] = 0;
        send(kind, { ...zero, ...combined(h) });
        if (!h.els.size) { clearInterval(h.timer); holds.delete(kind); }
    }
    // A held tone: { el → timer }.
    const tones = new Map();
    function pressTone(el) {
        if (el.disabled || tones.has(el)) return;
        const value = { name: el.dataset.tone, value: { note: 'A4' } };
        el.classList.add('held');
        send('actuator', value);
        tones.set(el, setInterval(() => send('actuator', value), HOLD_MS));
    }
    function releaseTone(el) {
        if (!tones.has(el)) return;
        clearInterval(tones.get(el));
        tones.delete(el);
        el.classList.remove('held');
        send('actuator', { name: el.dataset.tone, value: null });
    }
    function releaseAll() {
        for (const h of [...holds.values()]) for (const el of [...h.els.keys()]) releaseAxis(el);
        for (const el of [...tones.keys()]) releaseTone(el);
    }

    function holdable(el, press, release) {
        el.addEventListener('pointerdown', (e) => { e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ } press(el); });
        for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, () => release(el));
        el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    $$('[data-hold]').forEach((el) => holdable(el, pressAxis, releaseAxis));
    $$('[data-tone]').forEach((el) => holdable(el, pressTone, releaseTone));
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
    window.addEventListener('pagehide', releaseAll);

    // Keyboard: arrows (and WASD) hold the drive's buttons; Q/E rotate; Space stops.
    const KEYS = {
        ArrowUp: [['throttle', 'y'], 1], KeyW: [['throttle', 'y'], 1], ArrowDown: [['throttle', 'y'], 0], KeyS: [['throttle', 'y'], 0],
        ArrowLeft: [['steer', 'x'], 0], KeyA: [['steer', 'x'], 0], ArrowRight: [['steer', 'x'], 1], KeyD: [['steer', 'x'], 1],
        KeyQ: [['rotation'], 0], KeyE: [['rotation'], 1],
    };
    function keyButton(code) {
        const k = KEYS[code];
        if (!k) return null;
        for (const axis of k[0]) { const btns = $$(`.widget-drive [data-axis="${axis}"] [data-hold]`); if (btns.length) return btns[k[1]]; }
        return null;
    }
    const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    document.addEventListener('keydown', (e) => {
        if (typing(e)) return;
        if (e.code === 'Space') { e.preventDefault(); stopDrive(); return; }
        const b = keyButton(e.code);
        if (b) { e.preventDefault(); if (!e.repeat) pressAxis(b); }
    });
    document.addEventListener('keyup', (e) => { const b = keyButton(e.code); if (b) releaseAxis(b); });

    function stopDrive() {
        const h = holds.get('drive');
        if (h) for (const el of [...h.els.keys()]) releaseAxis(el);
        send('drive', {});   // every declared axis absent → 0
    }
    $$('[data-stop]').forEach((el) => el.addEventListener('click', stopDrive));

    // ── One-shot controls ─────────────────────────────────────────────────────────────────────────
    /** At most one send per HOLD_MS while a slider moves; the last value is always sent. */
    function throttled(fn) {
        let last = 0; let timer = null; let pending = null;
        return (...args) => {
            pending = args;
            const wait = HOLD_MS - (Date.now() - last);
            if (wait <= 0) { last = Date.now(); fn(...pending); pending = null; return; }
            if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); if (pending) fn(...pending); pending = null; }, wait);
        };
    }
    $$('[data-actuator]').forEach((el) => {
        const push = throttled(() => send('actuator', { name: el.dataset.actuator, value: Number(el.value) }));
        el.addEventListener('input', push);
    });
    const rgb = (hex) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
    $$('[data-rgb]').forEach((el) => {
        const push = throttled(() => send('actuator', { name: el.dataset.rgb, value: rgb(el.value) }));
        el.addEventListener('input', push);
    });
    $$('[data-rgb-off]').forEach((el) => el.addEventListener('click', () => send('actuator', { name: el.dataset.rgbOff, value: null })));
    $$('[data-bool]').forEach((el) => el.addEventListener('change', () => send('actuator', { name: el.dataset.bool, value: el.checked })));
    $$('form[data-say]').forEach((f) => f.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = f.elements.text.value.trim();
        if (text && send('say', { text })) f.elements.text.value = '';
    }));
    $$('form[data-display]').forEach((f) => f.addEventListener('submit', (e) => {
        e.preventDefault();
        const face = f.elements.face ? f.elements.face.value : '';
        const text = f.elements.text ? f.elements.text.value.trim() : '';
        if (face) send('display', { face });
        else if (text) send('display', { text });
    }));
    $$('[data-estop]').forEach((el) => el.addEventListener('click', () => { releaseAll(); raw({ type: 'estop' }); }));
    $$('[data-estop-clear]').forEach((el) => el.addEventListener('click', () => raw({ type: 'estop_clear' })));

    // ── State ─────────────────────────────────────────────────────────────────────────────────────
    function enableControls() {
        for (const section of $$('[data-command]')) {
            const ok = joined && allowed.includes(JSON.parse(section.dataset.command).kind);
            for (const el of $$('button, input, select', section)) el.disabled = !ok;
        }
    }
    function readout(v) {
        if (v == null) return '—';
        if (typeof v !== 'object') return String(v);
        return Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join(' · ') || '—';
    }
    function paint(state) {
        if (!state) return;
        const latched = !!(state.estop && state.estop.latched);
        const banner = $('[data-estop-banner]');
        if (banner) banner.dataset.latched = String(latched);
        const label = $('[data-estop-state]');
        if (label) label.textContent = latched ? 'E-stop latched' : 'E-stop clear';
        const clear = $('[data-estop-clear]');
        if (clear) clear.hidden = !latched;
        if (latched) releaseAll();
        const online = $('[data-online]');
        if (online) online.textContent = state.online ? 'online' : 'offline';
        main.dataset.online = String(!!state.online);
        for (const el of $$('[data-latency]')) el.textContent = state.latency_ms != null ? `${state.latency_ms} ms` : '—';
        for (const el of $$('[data-battery]')) el.value = state.battery != null ? state.battery : 0;
        for (const el of $$('[data-battery-text]')) el.textContent = state.battery != null ? `${Math.round(state.battery * 100)} %` : '—';
        const sensors = state.telemetry && state.telemetry.sensors;
        for (const el of $$('[data-telemetry]')) {
            const key = el.dataset.telemetry.replace(/^sensor\./, '');
            el.textContent = readout(sensors ? (sensors[key] !== undefined ? sensors[key] : sensors) : null);
        }
    }

    function onFrame(m) {
        if (m.type === 'joined') {
            joined = true; retry = 0;
            allowed = m.allowed_commands || [];
            const r = $('[data-role-label]');
            if (r) r.textContent = m.role;
            notice('');
            enableControls();
            paint(m.state);
        } else if (m.type === 'robot_state') {
            paint(m.state);
        } else if (m.type === 'command_result') {
            if (m.result === 'refused' && m.code !== 'bot.cooldown') notice(m.reason || m.code);
        } else if (m.type === 'error') {
            if (m.code === 'bot.not_an_operator' || m.code === 'bot.robot_not_found') { gone = true; joined = false; enableControls(); }
            notice(m.detail || m.code);
        }
    }

    function connect() {
        ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/control`);
        ws.onopen = () => raw({ type: 'join', robot_id: ROBOT_ID });
        ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onFrame(m); };
        ws.onclose = (e) => {
            releaseAll();
            joined = false;
            enableControls();
            const online = $('[data-online]');
            if (online) online.textContent = 'disconnected';
            if (e.code === 4002) { notice('Sign in again to drive this robot.'); return; }
            if (!gone) setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
        };
    }
    enableControls();
    connect();
})();
