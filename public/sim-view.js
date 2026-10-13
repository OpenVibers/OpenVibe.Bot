'use strict';

/**
 * The simulated rover's camera: every camera tile the server marked `data-sim-camera` (a robot whose profile's
 * driver is `sim`) draws the rover's view of the shared arena (public/sim-world.js) instead of waiting for video,
 * with a top-down map in its corner. Plain ES, no build step; canvas only, so the page's CSP is untouched.
 *
 * Where the pose comes from:
 *   - /try: the rover runs in this page (public/try-device.js sets window.OVSimLocal), so the view reads it each frame;
 *   - any other sim robot: Bot's in-process simulator reports `telemetry.sim` ({ pose, drive, headlights, horn,
 *     bumped }) about twice a second (panel.js re-dispatches each state as `ov-bot-state`). Between reports the view
 *     moves the rover on by its last drive with the same kinematics, and eases toward each new report.
 *
 * The horn plays through Web Audio once the page has been touched (browsers allow sound only after a gesture).
 */
(() => {
    const W = window.OVSimWorld;
    const tiles = [...document.querySelectorAll('[data-sim-camera]')];
    if (!W || !tiles.length) return;

    const RW = 400; const RH = 225;              // the rendered picture; drawn scaled up, smoothed
    const FOV = 74;                              // degrees across
    const F = (RW / 2) / Math.tan((FOV / 2) * Math.PI / 180);
    const HORIZON = Math.round(RH * 0.46);
    const CAM = W.CAMERA_HEIGHT;

    // Colours (linear-ish 0..255 RGB).
    const SOLID = { '#': [96, 112, 138], r: [214, 84, 66], b: [59, 130, 246], g: [34, 160, 107], y: [226, 178, 36] };
    const FLOOR = { tile: [182, 190, 201], tile2: [164, 173, 186], line: [244, 192, 38] };
    const FOG = [196, 205, 218];
    const SKY_TOP = [58, 68, 86]; const SKY_LOW = [150, 162, 180];

    // ── Pose: local (the /try rover) or predicted from the server's reports ──────────────────────────
    const remote = { pose: null, drive: {}, headlights: null, horn: null, online: false };
    let shown = null;           // the pose drawn last
    let correction = null;      // { dx, dy, dh } still to blend in

    window.addEventListener('ov-bot-state', (e) => {
        const state = e.detail || {};
        remote.online = !!state.online;
        const sim = state.telemetry && state.telemetry.sim;
        if (!sim || !sim.pose) return;
        remote.drive = sim.drive || {};
        remote.headlights = sim.headlights || null;
        remote.horn = sim.horn || null;
        if (!shown) { shown = { ...sim.pose }; return; }
        let dh = (sim.pose.heading - shown.heading) % 360;
        if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
        const far = Math.hypot(sim.pose.x - shown.x, sim.pose.y - shown.y) > 0.6 || Math.abs(dh) > 60;
        if (far) { shown = { ...sim.pose }; correction = null; } else correction = { dx: sim.pose.x - shown.x, dy: sim.pose.y - shown.y, dh };
    });
    // The operator's own drive moves the picture at once (the server's report confirms it a moment later).
    window.addEventListener('ov-bot-command', (e) => {
        const c = e.detail || {};
        if (c.kind === 'drive' && c.value && typeof c.value === 'object') remote.drive = { ...c.value };
        if (c.kind === 'halt') remote.drive = {};
    });

    function frameState(dt) {
        const local = window.OVSimLocal;
        if (local) return { pose: local.pose(), headlights: local.headlights(), horn: local.horn(), online: true };
        if (!shown || !remote.online) return { pose: shown, headlights: null, horn: null, online: remote.online && !!shown };
        shown = W.step(shown, remote.drive, dt).pose;
        if (correction) {
            const k = Math.min(1, dt * 6);
            shown = { x: shown.x + correction.dx * k, y: shown.y + correction.dy * k, heading: (shown.heading + correction.dh * k + 360) % 360 };
            correction = { dx: correction.dx * (1 - k), dy: correction.dy * (1 - k), dh: correction.dh * (1 - k) };
            if (Math.abs(correction.dx) + Math.abs(correction.dy) < 0.002 && Math.abs(correction.dh) < 0.2) correction = null;
        }
        return { pose: shown, headlights: remote.headlights, horn: remote.horn, online: true };
    }

    // ── The renderer: floor casting, then each column's solids far to near ───────────────────────────
    const buffer = document.createElement('canvas');
    buffer.width = RW; buffer.height = RH;
    const bctx = buffer.getContext('2d');
    const img = bctx.createImageData(RW, RH);
    const px = img.data;
    const lerp = (a, b, t) => a + (b - a) * t;
    function put(i, c, fog, light) {
        px[i] = Math.min(255, lerp(c[0], FOG[0], fog) + light[0]);
        px[i + 1] = Math.min(255, lerp(c[1], FOG[1], fog) + light[1]);
        px[i + 2] = Math.min(255, lerp(c[2], FOG[2], fog) + light[2]);
        px[i + 3] = 255;
    }
    const NO_LIGHT = [0, 0, 0];
    /** The headlights' added colour at a point `d` metres ahead and `lateral` (screen fraction) off the axis. */
    function lit(lights, d, lateral) {
        if (!lights) return NO_LIGHT;
        const cone = Math.max(0, 1 - Math.abs(lateral) / 0.55);
        const k = (0.75 * cone * cone) / (1 + d * d * 1.6);
        return [lights.r * k, lights.g * k, lights.b * k];
    }

    function render({ pose, headlights }) {
        const a = (pose.heading * Math.PI) / 180;
        const fx = Math.sin(a); const fy = Math.cos(a);       // forward
        const rx = Math.cos(a); const ry = -Math.sin(a);      // right
        // Above the horizon: the room beyond the arena.
        for (let y = 0; y <= HORIZON; y++) {
            const t = y / HORIZON;
            const c = [lerp(SKY_TOP[0], SKY_LOW[0], t), lerp(SKY_TOP[1], SKY_LOW[1], t), lerp(SKY_TOP[2], SKY_LOW[2], t)];
            for (let x = 0; x < RW; x++) put((y * RW + x) * 4, c, 0, NO_LIGHT);
        }
        // The floor: each row is one distance; each pixel one point on it.
        for (let y = HORIZON + 1; y < RH; y++) {
            const d = (CAM * F) / (y - HORIZON);
            const fog = 1 - Math.exp(-d * 0.16);
            for (let x = 0; x < RW; x++) {
                const s = (x - RW / 2 + 0.5) / F;
                const wx = pose.x + (fx + rx * s) * d; const wy = pose.y + (fy + ry * s) * d;
                put((y * RW + x) * 4, FLOOR[W.floorAt(wx, wy)], fog, lit(headlights, d, s));
            }
        }
        // Solids: arena walls and crates, far first so nearer ones cover them.
        for (let x = 0; x < RW; x++) {
            const s = (x - RW / 2 + 0.5) / F;
            const off = Math.atan(s);
            const hits = W.cast(pose.x, pose.y, pose.heading + (off * 180) / Math.PI, 14);
            for (let h = hits.length - 1; h >= 0; h--) {
                const hit = hits[h];
                const pd = Math.max(0.02, hit.dist * Math.cos(off));
                const height = W.heights[hit.cell] || 0.4;
                const top = HORIZON - ((height - CAM) * F) / pd;
                const bottom = HORIZON + (CAM * F) / pd;
                const y0 = Math.max(0, Math.ceil(top)); const y1 = Math.min(RH - 1, Math.floor(bottom));
                const base = SOLID[hit.cell] || SOLID['#'];
                const shade = hit.side === 'x' ? 0.8 : 1;
                const fog = 1 - Math.exp(-pd * 0.16);
                const light = lit(headlights, pd, s);
                const crate = hit.cell !== '#';
                const edgeU = hit.u < 0.06 || hit.u > 0.94;
                for (let y = y0; y <= y1; y++) {
                    const v = (y - top) / Math.max(1, bottom - top);        // 0 at the top edge, 1 at the floor
                    let k = shade;
                    if (crate) { if (edgeU || v < 0.07 || v > 0.93) k *= 0.72; else if (Math.abs(v - 0.5) < 0.04) k *= 0.86; }
                    else { if (v < 0.08) k *= 1.18; else if (v > 0.9) k *= 0.7; if (hit.u < 0.02 || Math.abs(hit.u - 0.5) < 0.012) k *= 0.85; }
                    put((y * RW + x) * 4, [base[0] * k, base[1] * k, base[2] * k], fog, light);
                }
            }
        }
        bctx.putImageData(img, 0, 0);
    }

    /** The top-down map: the arena, the tape, the rover and its heading (+y up). */
    function renderMap(ctx, w, h, { pose, headlights }) {
        const s = Math.min(w / (W.COLS * W.CELL), h / (W.ROWS * W.CELL));
        const X = (x) => x * s; const Y = (y) => h - y * s;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(17, 21, 28, 0.72)';
        ctx.fillRect(0, 0, w, h);
        for (let cy = 0; cy < W.ROWS; cy++) for (let cx = 0; cx < W.COLS; cx++) {
            const cell = W.cellAt(cx, cy);
            if (cell === '.') continue;
            const c = SOLID[cell];
            ctx.fillStyle = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
            ctx.fillRect(X(cx * W.CELL), Y((cy + 1) * W.CELL), W.CELL * s + 0.5, W.CELL * s + 0.5);
        }
        const L = W.LOOP;
        ctx.strokeStyle = 'rgba(242, 194, 48, 0.9)';
        ctx.lineWidth = Math.max(1, s * 0.05);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(X(L.x0), Y(L.y1), (L.x1 - L.x0) * s, (L.y1 - L.y0) * s, L.r * s);
        else ctx.rect(X(L.x0), Y(L.y1), (L.x1 - L.x0) * s, (L.y1 - L.y0) * s);
        ctx.stroke();
        if (!pose) return;
        const a = (pose.heading * Math.PI) / 180;
        const r = Math.max(4, W.ROVER_RADIUS * s * 1.4);
        const cx = X(pose.x); const cy = Y(pose.y);
        if (headlights) {
            const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 5);
            g.addColorStop(0, `rgba(${headlights.r}, ${headlights.g}, ${headlights.b}, 0.55)`);
            g.addColorStop(1, `rgba(${headlights.r}, ${headlights.g}, ${headlights.b}, 0)`);
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, r * 5, a - Math.PI / 2 - 0.5, a - Math.PI / 2 + 0.5);   // canvas angles: 0 is +x, clockwise
            ctx.fill();
        }
        ctx.fillStyle = '#f8fafc';
        ctx.strokeStyle = '#11151c';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        // Screen angle: heading 0 is up (−y on the canvas), clockwise positive.
        const pt = (ang, rad) => [cx + Math.sin(a + ang) * rad, cy - Math.cos(a + ang) * rad];
        ctx.moveTo(...pt(0, r * 1.3));
        ctx.lineTo(...pt(2.5, r));
        ctx.lineTo(...pt(Math.PI, r * 0.45));
        ctx.lineTo(...pt(-2.5, r));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }

    // ── The horn ──────────────────────────────────────────────────────────────────────────────────────
    let audio = null; let osc = null; let gain = null; let toneHz = null;
    const unlock = () => {
        if (audio) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        try { audio = new Ctx(); } catch { audio = null; }
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    function horn(h) {
        const hz = h && Number.isFinite(h.hz) ? h.hz : null;
        if (hz === toneHz || !audio) return;
        toneHz = hz;
        if (osc) { try { gain.gain.setTargetAtTime(0, audio.currentTime, 0.015); osc.stop(audio.currentTime + 0.08); } catch { /* stopped */ } osc = null; }
        if (hz == null) return;
        osc = audio.createOscillator();
        gain = audio.createGain();
        osc.type = 'square';
        osc.frequency.value = hz;
        gain.gain.value = 0;
        gain.gain.setTargetAtTime(0.05, audio.currentTime, 0.01);
        osc.connect(gain).connect(audio.destination);
        osc.start();
        if (audio.state === 'suspended') audio.resume().catch(() => {});
    }

    // ── One canvas per tile ───────────────────────────────────────────────────────────────────────────
    const views = tiles.map((tile) => {
        const screen = tile.querySelector('[data-camera-screen]');
        if (!screen) return null;
        const placeholder = [...screen.children];
        const canvas = document.createElement('canvas');
        canvas.className = 'sim-camera';
        canvas.width = RW * 2; canvas.height = RH * 2;
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', 'The simulated rover\'s front camera');
        canvas.hidden = true;
        const map = document.createElement('canvas');
        map.className = 'sim-map';
        map.width = 192; map.height = 144;
        map.setAttribute('role', 'img');
        map.setAttribute('aria-label', 'Map of the arena with the rover');
        map.hidden = true;
        const hud = document.createElement('span');
        hud.className = 'sim-hud';
        hud.hidden = true;
        screen.append(canvas, map, hud);
        return { screen, placeholder, canvas, ctx: canvas.getContext('2d'), map, mctx: map.getContext('2d'), hud, live: false };
    }).filter(Boolean);

    function show(v, on) {
        if (v.live === on) return;
        v.live = on;
        v.canvas.hidden = !on; v.map.hidden = !on; v.hud.hidden = !on;
        for (const el of v.placeholder) el.hidden = on;
        v.screen.classList.toggle('sim-live', on);
    }

    let last = performance.now();
    function frame(now) {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        const st = frameState(dt);
        horn(st.online ? st.horn : null);
        if (!document.hidden && st.online && st.pose) {
            render(st);
            for (const v of views) {
                show(v, true);
                v.ctx.imageSmoothingEnabled = true;
                v.ctx.drawImage(buffer, 0, 0, v.canvas.width, v.canvas.height);
                renderMap(v.mctx, v.map.width, v.map.height, st);
                const cm = W.distanceCm(st.pose);
                const text = `${cm >= 400 ? '> 4 m' : `${cm} cm`} ahead`;
                if (v.hud.textContent !== text) v.hud.textContent = text;
            }
        } else if (!st.online) for (const v of views) show(v, false);
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})();
