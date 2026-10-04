'use strict';

/**
 * The panel client (plain ES, no build step, no framework). The server rendered every widget from the robot's
 * profile (server/web/render.js); this wires them to wss://<host>/control with the session cookie: `join`,
 * paint the robot's state, and send each command with a fresh id (an id is an idempotency key, so a re-send
 * with the same one would never reach the robot).
 *
 * Every held input — a hold button, the touch joystick, a key, a gamepad's stick or d-pad — is one source of a
 * command kind; the sources of one kind are merged into one value, re-sent every holdResendMs while any is
 * held, and releasing a source sends its axes at zero at once: the device's deadline is the last line of
 * defence, never the way a panel stops a robot. Losing the socket, the window or the page releases everything.
 *
 *   joystick  pointer events with pointer capture, a deadzone; pointerup/cancel → a zero drive at once
 *   keyboard  arrows/WASD drive, Q/E rotate, Space stops (unchanged)
 *   gamepad   polled on requestAnimationFrame only while a pad is connected and the page has focus: left stick
 *             (and d-pad) drive, right stick rotates when the drive has a rotation axis, A = the first tone,
 *             B = stop, Start = e-stop; gamepaddisconnected releases it all
 *   latency   round trip from a command's id to its result on /control (rolling median) + telemetry age
 *
 * A watcher (data-role="watcher": the embed's anonymous, read-only view) joins on /watch instead and only paints
 * the state it is sent: no command, e-stop or clear frame is ever sent from it.
 *
 * Also on the pairing page: [data-copy] copies the installer command, and [data-pair-robot] joins the robot on
 * /control (the owner's own, read-only use of it) to flip "Waiting for the device." when the device connects.
 */
(() => {
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
    const wsUrl = (path = '/control') => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;

    for (const b of $$('[data-copy]')) {
        b.addEventListener('click', () => {
            const src = $('[data-copy-source]');
            const label = $('[data-copy-label]', b);
            if (src && navigator.clipboard) {
                navigator.clipboard.writeText(src.textContent).then(() => {
                    b.dataset.copied = 'true';
                    if (label) label.textContent = 'Copied';
                    setTimeout(() => { delete b.dataset.copied; if (label) label.textContent = 'Copy the command'; }, 2000);
                }, () => {});
            }
        });
    }

    // ── Pairing page: a live online indicator ─────────────────────────────────────────────────────────
    const pair = $('[data-pair-robot]');
    if (pair) {
        const status = $('[data-pair-status]');
        const text = $('[data-pair-text]');
        const open = $('[data-pair-open]');
        let tries = 0;
        const show = (online) => {
            status.dataset.state = online ? 'online' : 'waiting';
            text.textContent = online ? 'The device is connected.' : 'Waiting for the device.';
            open.hidden = !online;
        };
        const watch = () => {
            const ws = new WebSocket(wsUrl());
            ws.onopen = () => ws.send(JSON.stringify({ v: 1, type: 'join', robot_id: pair.dataset.pairRobot }));
            ws.onmessage = (e) => {
                let m; try { m = JSON.parse(e.data); } catch { return; }
                if ((m.type === 'joined' || m.type === 'robot_state') && m.state) { tries = 0; show(!!m.state.online); }
                if (m.type === 'error' && /not_an_operator|robot_not_found/.test(m.code)) { tries = -1; ws.close(); }
            };
            ws.onclose = (e) => { if (tries >= 0 && e.code !== 4002) setTimeout(watch, Math.min(10000, 1000 * 2 ** tries++)); };
        };
        watch();
        return;
    }

    const main = document.getElementById('panel');
    if (!main) return;
    const ROBOT_ID = main.dataset.robotId;
    const WATCHER = main.dataset.role === 'watcher';
    const HOLD_MS = Number(main.dataset.holdMs) || 150;
    const MIN_GAP_MS = 40;        // a moving stick sends at most this often between the hold re-sends
    const STICK_DEADZONE = 0.12;  // touch joystick, fraction of its radius
    const PAD_DEADZONE = 0.18;    // gamepad sticks drift more than a finger
    let allowed = JSON.parse(main.dataset.allowed || '[]');
    let ws = null;
    let joined = false;
    let retry = 0;
    let gone = false;          // refused for good (no access): no reconnect

    const commandOf = (el) => { const s = el.closest('[data-command]'); return s ? JSON.parse(s.dataset.command) : null; };
    const kindOf = (el) => { const c = commandOf(el); return c ? c.kind : null; };
    const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const round = (v) => Math.round(v * 100) / 100;

    function notice(text) {
        const n = $('[data-notice]');
        if (!n) return;
        n.textContent = text || '';
        n.hidden = !text;
    }
    function raw(frame) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        if (WATCHER && frame.type !== 'join') return false;   // /watch is read-only
        ws.send(JSON.stringify({ v: 1, ...frame }));
        return true;
    }

    // ── Latency: a command's id → its result ──────────────────────────────────────────────────────────
    const sentAt = new Map();     // id → performance.now() at send
    const samples = [];           // the last round trips, ms
    let lastTelemetryAt = 0;
    function send(kind, value) {
        if (!joined || !allowed.includes(kind)) return false;
        const id = newId();
        if (!raw({ type: 'command', id, kind, value })) return false;
        sentAt.set(id, performance.now());
        if (sentAt.size > 200) sentAt.delete(sentAt.keys().next().value);
        return true;
    }
    const quality = (ms, ok, poor) => (ms == null ? 'none' : ms <= ok ? 'good' : ms <= poor ? 'fair' : 'poor');
    function roundTrip(id, result) {
        const t0 = sentAt.get(id);
        if (t0 == null) return;
        sentAt.delete(id);
        if (result !== 'ack' && result !== 'nack') return;     // refused/expired never reached the robot and back
        samples.push(performance.now() - t0);
        if (samples.length > 21) samples.shift();
        const sorted = [...samples].sort((a, b) => a - b);
        const median = Math.round(sorted[Math.floor(sorted.length / 2)]);
        for (const el of $$('[data-latency]')) { el.textContent = `${median} ms`; el.dataset.quality = quality(median, 120, 300); }
    }
    function paintAge() {
        const age = lastTelemetryAt ? performance.now() - lastTelemetryAt : null;
        for (const el of $$('[data-telemetry-age]')) {
            el.textContent = age == null ? '—' : age < 1000 ? `${Math.round(age / 100) * 100} ms` : `${(age / 1000).toFixed(age < 10000 ? 1 : 0)} s`;
            el.dataset.quality = quality(age, 1500, 4000);
        }
    }
    if ($('[data-telemetry-age]')) setInterval(paintAge, 250);

    // ── Held sources ──────────────────────────────────────────────────────────────────────────────────
    // kind → { src: Map<source, value>, timer, last, sent }: the sources of one kind are sent as one value.
    const holds = new Map();
    const combined = (h) => Object.assign({}, ...h.src.values());
    function sendHeld(kind, h) {
        clearTimeout(h.trail);
        h.trail = null;
        const value = combined(h);
        h.last = performance.now();
        h.sent = JSON.stringify(value);
        send(kind, value);
        paintStick(kind, value);
    }
    /** Press or move a source: sent at once when new, else when it changed and MIN_GAP_MS has passed. */
    function holdSet(kind, source, value) {
        if (!kind) return;
        let h = holds.get(kind);
        if (!h) { h = { src: new Map(), timer: null, trail: null, last: 0, sent: null }; holds.set(kind, h); }
        const fresh = !h.src.has(source);
        h.src.set(source, value);
        const wait = MIN_GAP_MS - (performance.now() - h.last);
        if (fresh || (JSON.stringify(combined(h)) !== h.sent && wait <= 0)) sendHeld(kind, h);
        else if (JSON.stringify(combined(h)) !== h.sent && !h.trail) h.trail = setTimeout(() => sendHeld(kind, h), wait);
        if (!h.timer) h.timer = setInterval(() => sendHeld(kind, h), HOLD_MS);
    }
    /** Let a source go: its axes are sent at zero at once (merged with what is still held). */
    function holdRelease(kind, source) {
        const h = kind && holds.get(kind);
        if (!h || !h.src.has(source)) return;
        const released = h.src.get(source);
        h.src.delete(source);
        const zero = {};
        for (const axis of Object.keys(released)) zero[axis] = 0;
        const value = { ...zero, ...combined(h) };
        send(kind, value);
        if (!h.src.size) { clearInterval(h.timer); clearTimeout(h.trail); holds.delete(kind); paintStick(kind, {}); } else paintStick(kind, value);
    }

    // Hold buttons (the axes the joystick does not cover, the ptz pad).
    function pressButton(el) {
        if (el.disabled) return;
        el.classList.add('held');
        holdSet(kindOf(el), el, JSON.parse(el.dataset.hold));
    }
    function releaseButton(el) { el.classList.remove('held'); holdRelease(kindOf(el), el); }
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
        for (const [kind, h] of [...holds]) for (const source of [...h.src.keys()]) {
            if (source instanceof Element) releaseButton(source); else holdRelease(kind, source);
        }
        for (const el of [...tones.keys()]) releaseTone(el);
        for (const s of sticks) s.release();
        pad.reset();
        for (const el of $$('.held')) el.classList.remove('held');
    }

    function holdable(el, press, release) {
        el.addEventListener('pointerdown', (e) => { e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ } press(el); });
        for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, () => release(el));
        el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    $$('[data-hold]').forEach((el) => holdable(el, pressButton, releaseButton));
    $$('[data-tone]').forEach((el) => holdable(el, pressTone, releaseTone));
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
    window.addEventListener('pagehide', releaseAll);

    // ── The drive's axes, read from the page (the profile's ranges) ───────────────────────────────────
    const driveSection = $('.widget-drive[data-command]');
    const DRIVE = driveSection ? JSON.parse(driveSection.dataset.command).kind : 'drive';
    const drivePad = driveSection && $('[data-axes]', driveSection);
    const driveAxes = drivePad ? JSON.parse(drivePad.dataset.axes) : {};
    const stickEl = driveSection && $('[data-joystick]', driveSection);
    const STICK = stickEl ? JSON.parse(stickEl.dataset.joystick) : {};
    /** A unit value on an axis → the axis's range (negative to its low end, positive to its high end). */
    const scale = (axis, u) => { const r = driveAxes[axis]; return r ? round(u >= 0 ? u * r[1] : -u * r[0]) : 0; };
    /** A stick position (x right, y up, both -1…1) past a radial deadzone → the drive value for the stick's axes. */
    function stickValue(x, y, deadzone) {
        const r = Math.hypot(x, y);
        const k = r <= deadzone ? 0 : Math.min(1, (r - deadzone) / (1 - deadzone)) / r;
        const v = {};
        if (STICK.x) v[STICK.x] = scale(STICK.x, x * k);
        if (STICK.y) v[STICK.y] = scale(STICK.y, y * k);
        return v;
    }

    // ── Touch joystick ────────────────────────────────────────────────────────────────────────────────
    const sticks = [];
    function paintStick(kind, value) {
        if (kind !== DRIVE || !stickEl) return;
        const knob = $('[data-knob]', stickEl);
        const unit = (axis) => { const v = Number(value[axis]) || 0; const r = driveAxes[axis]; return !r ? 0 : v >= 0 ? (r[1] ? v / r[1] : 0) : (r[0] ? -v / r[0] : 0); };
        const x = STICK.x ? unit(STICK.x) : 0;
        const y = STICK.y ? unit(STICK.y) : 0;
        const m = Math.hypot(x, y) > 1 ? Math.hypot(x, y) : 1;
        knob.style.transform = `translate(${(x / m) * 75}%, ${(-y / m) * 75}%)`;   // the knob is 40 % of the stick: 75 % of it reaches the rim
        stickEl.classList.toggle('active', x !== 0 || y !== 0);
    }
    if (stickEl) {
        let pointer = null;
        const source = 'stick';
        const at = (e) => {
            const r = stickEl.getBoundingClientRect();
            const radius = r.width / 2;
            let x = (e.clientX - (r.left + radius)) / radius;
            let y = -(e.clientY - (r.top + r.height / 2)) / radius;
            const m = Math.hypot(x, y);
            if (m > 1) { x /= m; y /= m; }
            return stickValue(x, y, STICK_DEADZONE);
        };
        const release = () => {
            if (pointer == null) return;
            pointer = null;
            stickEl.classList.remove('held');
            holdRelease(DRIVE, source);
        };
        stickEl.addEventListener('pointerdown', (e) => {
            if (stickEl.getAttribute('aria-disabled') === 'true' || pointer != null) return;
            e.preventDefault();
            pointer = e.pointerId;
            try { stickEl.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
            stickEl.classList.add('held');
            holdSet(DRIVE, source, at(e));
        });
        stickEl.addEventListener('pointermove', (e) => { if (e.pointerId === pointer) holdSet(DRIVE, source, at(e)); });
        for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) stickEl.addEventListener(ev, (e) => { if (e.pointerId === pointer) release(); });
        stickEl.addEventListener('contextmenu', (e) => e.preventDefault());
        sticks.push({ release });
    }

    // ── Keyboard: arrows (and WASD) drive; Q/E rotate; Space stops ────────────────────────────────────
    const KEYS = {
        ArrowUp: [['throttle', 'y'], 1], KeyW: [['throttle', 'y'], 1], ArrowDown: [['throttle', 'y'], 0], KeyS: [['throttle', 'y'], 0],
        ArrowLeft: [['steer', 'x'], 0], KeyA: [['steer', 'x'], 0], ArrowRight: [['steer', 'x'], 1], KeyD: [['steer', 'x'], 1],
        KeyQ: [['rotation'], 0], KeyE: [['rotation'], 1],
    };
    /** A key → { axis: its end of the range } on the drive, or null when the drive has none of its axes. */
    function keyValue(code) {
        const k = KEYS[code];
        if (!k) return null;
        const axis = k[0].find((a) => driveAxes[a]);
        return axis ? { [axis]: driveAxes[axis][k[1]] } : null;
    }
    const driveEnabled = () => joined && allowed.includes(DRIVE);
    function keyPress(code, source) {
        const v = keyValue(code);
        if (!v || !driveEnabled()) return false;
        holdSet(DRIVE, source, v);
        const btn = driveSection && $(`[data-hold='${JSON.stringify(v)}']`, driveSection);
        if (btn) btn.classList.add('held');
        return true;
    }
    function keyRelease(code, source) {
        const v = keyValue(code);
        const btn = v && driveSection && $(`[data-hold='${JSON.stringify(v)}']`, driveSection);
        if (btn) btn.classList.remove('held');
        holdRelease(DRIVE, source);
    }
    const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    document.addEventListener('keydown', (e) => {
        if (typing(e)) return;
        if (e.code === 'Space') { e.preventDefault(); stopDrive(); return; }
        if (keyValue(e.code)) { e.preventDefault(); if (!e.repeat) keyPress(e.code, `key:${e.code}`); }
    });
    document.addEventListener('keyup', (e) => { if (KEYS[e.code]) keyRelease(e.code, `key:${e.code}`); });

    function stopDrive() {
        const h = holds.get(DRIVE);
        if (h) for (const source of [...h.src.keys()]) { if (source instanceof Element) releaseButton(source); else holdRelease(DRIVE, source); }
        for (const s of sticks) s.release();
        send(DRIVE, {});   // every declared axis absent → 0
    }
    $$('[data-stop]').forEach((el) => el.addEventListener('click', stopDrive));
    function estop() { releaseAll(); raw({ type: 'estop' }); }

    // ── Gamepad ───────────────────────────────────────────────────────────────────────────────────────
    const PAD_DPAD = { 12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight' };
    /** A stick axis past its deadzone, rescaled to -1…1. */
    const dead = (v, dz) => (Math.abs(v) <= dz ? 0 : Math.sign(v) * Math.min(1, (Math.abs(v) - dz) / (1 - dz)));
    const ROTATE = STICK.x !== 'rotation' && driveAxes.rotation ? 'rotation' : null;
    const pad = {
        loop: 0,
        down: new Set(),      // buttons held at the last poll
        tone: null,           // the tone button A holds
        // After a reset (blur, a hidden page, the e-stop) nothing is pressed again until the pad is let go of
        // entirely: a stick still pushed or a button still held does not undo a release.
        latched: false,
        reset() {
            holdRelease(DRIVE, 'pad');
            for (const [b, code] of Object.entries(PAD_DPAD)) if (this.down.has(Number(b))) keyRelease(code, `pad:${b}`);
            if (this.tone) { releaseTone(this.tone); this.tone = null; }
            this.latched = true;
        },
    };
    function padPoll() {
        pad.loop = 0;
        const p = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find((g) => g && g.connected);
        if (!p) { pad.reset(); pad.down.clear(); return; }      // the last pad went: stop polling
        const ax = (i) => Number(p.axes[i]) || 0;
        const v = stickValue(ax(0), -ax(1), PAD_DEADZONE);
        if (ROTATE) v[ROTATE] = scale(ROTATE, dead(ax(2), PAD_DEADZONE));
        const moving = Object.values(v).some((x) => x !== 0);
        const now = new Set(p.buttons.map((b, i) => (b && b.pressed ? i : -1)).filter((i) => i >= 0));
        if (!document.hasFocus() || document.hidden || !driveEnabled()) {
            if (!pad.latched) pad.reset();
        } else if (pad.latched) {
            if (!moving && !now.size) pad.latched = false;
        } else {
            if (moving) holdSet(DRIVE, 'pad', v);
            else holdRelease(DRIVE, 'pad');
            for (const b of now) if (!pad.down.has(b)) {
                if (PAD_DPAD[b]) keyPress(PAD_DPAD[b], `pad:${b}`);
                else if (b === 0) { pad.tone = $$('[data-tone]').find((el) => !el.disabled) || null; if (pad.tone) pressTone(pad.tone); }
                else if (b === 1) { stopDrive(); pad.reset(); }     // a stick still pushed does not drive on
                else if (b === 9 && $('[data-estop]')) estop();
            }
            for (const b of pad.down) if (!now.has(b)) {
                if (PAD_DPAD[b]) keyRelease(PAD_DPAD[b], `pad:${b}`);
                else if (b === 0 && pad.tone) { releaseTone(pad.tone); pad.tone = null; }
            }
        }
        pad.down = now;
        pad.loop = requestAnimationFrame(padPoll);
    }
    const padStart = () => {
        main.dataset.gamepad = 'true';
        if (!pad.loop) { pad.latched = false; pad.down.clear(); pad.loop = requestAnimationFrame(padPoll); }   // a fresh pad has nothing to undo
    };
    window.addEventListener('gamepadconnected', padStart);
    window.addEventListener('gamepaddisconnected', () => {
        pad.reset();
        pad.down.clear();
        if (![...(navigator.getGamepads ? navigator.getGamepads() : [])].some((g) => g && g.connected)) {
            cancelAnimationFrame(pad.loop); pad.loop = 0; delete main.dataset.gamepad;
        }
    });
    if ([...(navigator.getGamepads ? navigator.getGamepads() : [])].some((g) => g && g.connected)) padStart();

    // ── One-shot controls ─────────────────────────────────────────────────────────────────────────────
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
    $$('[data-estop]').forEach((el) => el.addEventListener('click', estop));
    $$('[data-estop-clear]').forEach((el) => el.addEventListener('click', () => raw({ type: 'estop_clear' })));

    // Each camera tile takes its camera's shape (CSSOM, so the CSP's no-inline rule holds).
    for (const cam of $$('[data-resolution]')) {
        const [w, h] = cam.dataset.resolution.split('x').map(Number);
        const screen = $('[data-camera-screen]', cam);
        if (w > 0 && h > 0 && screen) screen.style.aspectRatio = `${w} / ${h}`;
    }

    // ── State ─────────────────────────────────────────────────────────────────────────────────────────
    function enableControls() {
        for (const section of $$('[data-command]')) {
            const ok = joined && allowed.includes(JSON.parse(section.dataset.command).kind);
            for (const el of $$('button, input, select', section)) el.disabled = !ok;
            for (const el of $$('[data-joystick]', section)) { if (ok) el.removeAttribute('aria-disabled'); else el.setAttribute('aria-disabled', 'true'); }
        }
    }
    function readout(v) {
        if (v == null) return '—';
        if (typeof v !== 'object') return String(v);
        return Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join(' · ') || '—';
    }
    function setOnline(state, label) {
        const pill = $('[data-online-pill]');
        if (pill) pill.dataset.state = state;
        const online = $('[data-online-label]');
        if (online) online.textContent = label;
    }
    function paint(state) {
        if (!state) return;
        const latched = !!(state.estop && state.estop.latched);
        const banner = $('[data-estop-banner]');
        if (banner) banner.dataset.latched = String(latched);
        const label = $('[data-estop-state]');
        if (label) label.textContent = latched ? 'E-stop latched' : 'E-stop clear';
        const note = $('.estop-note');
        if (note) note.textContent = latched ? ' — the robot stays still until the owner clears it.' : '';
        const clear = $('[data-estop-clear]');
        if (clear) clear.hidden = !latched;
        if (latched) releaseAll();
        setOnline(state.online ? 'online' : 'offline', state.online ? 'Online' : 'Device offline');
        main.dataset.deviceOnline = String(!!state.online);
        if (state.telemetry) lastTelemetryAt = performance.now();
        else if (!state.online) lastTelemetryAt = 0;
        paintAge();
        for (const el of $$('[data-link]')) el.textContent = state.latency_ms != null ? `${state.latency_ms} ms` : '—';
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
            notice('');
            enableControls();
            paint(m.state);
        } else if (m.type === 'robot_state') {
            paint(m.state);
        } else if (m.type === 'command_result') {
            roundTrip(m.id, m.result);
            if (m.result === 'refused' && m.code !== 'bot.cooldown') notice(m.reason || m.code);
        } else if (m.type === 'error') {
            if (m.code === 'bot.not_an_operator' || m.code === 'bot.robot_not_found') { gone = true; joined = false; enableControls(); }
            notice(m.detail || m.code);
        }
    }

    function connect() {
        ws = new WebSocket(wsUrl(WATCHER ? '/watch' : '/control'));
        ws.onopen = () => raw({ type: 'join', robot_id: ROBOT_ID });
        ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onFrame(m); };
        ws.onclose = (e) => {
            releaseAll();
            joined = false;
            enableControls();
            setOnline('disconnected', 'Reconnecting…');
            if (e.code === 4002) { setOnline('disconnected', 'Signed out'); notice('Sign in again to drive this robot.'); return; }
            if (!gone) setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
        };
    }
    enableControls();
    connect();
})();
