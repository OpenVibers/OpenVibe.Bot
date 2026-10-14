'use strict';

/**
 * /device/phone: this phone is the robot's device, from its browser, with nothing to install (plan T15 "an Android
 * phone as the robot's brain", profile driver `phone`). Plain ES, no build step, no framework.
 *
 *   pair     POST /api/v1/pair with the one-time code (from the pairing page's QR code, or typed) → the device id,
 *            its credential and its WHIP URL, kept in this browser's localStorage (shown once by Bot, so kept here)
 *   link     wss://<host>/device, the credential offered as the subprotocol `ov.device.<credential>` (a browser
 *            cannot set the Authorization header); hello → config → status, then a heartbeat every
 *            config.heartbeat_ms and telemetry (battery, tilt) at most once a second
 *   camera   getUserMedia → WHIP (RFC 9725) to OpenRestream at the whip_url Bot gave at pairing; the robot's panel
 *            plays it. Restarted with backoff when it drops
 *   commands say (speechSynthesis), display (a face or text, full screen), actuator torch (the camera's torch) and
 *            chime (a tone while it is held: its deadline ends it, as a motor's does), halt; each acked or nacked
 *   safety   Bot's e-stop silences everything and refuses all but halt; the phone's own Stop button latches a local
 *            stop (estop_state local_stop) that only this phone's Resume releases
 *
 * The page needs one tap to start (browsers allow sound, the camera and the wake lock only after a gesture).
 */
(() => {
    const main = document.getElementById('phone');
    if (!main) return;
    const $ = (sel) => main.querySelector(sel);
    const KEY = 'ovbot.phone.v1';
    const AGENT = 'openvibe-phone/1';
    const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
    const save = (d) => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* private mode: this visit only */ } };
    const forget = () => { try { localStorage.removeItem(KEY); } catch { /* nothing kept */ } };

    // ── Setup: the QR code's fragment (#robot=…&code=…) fills the form, then leaves the address bar ──────────
    const form = $('[data-pair-form]');
    const errorEl = $('[data-error]');
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (fragment.get('robot')) form.elements.robot.value = fragment.get('robot');
    if (fragment.get('code')) form.elements.code.value = fragment.get('code');
    if (location.hash) history.replaceState(null, '', location.pathname);
    if (form.elements.robot.value) $('[data-robot-field]').hidden = true;

    let dev = load();
    function showError(text) { errorEl.textContent = text || ''; errorEl.hidden = !text; }
    function showSetup() {
        main.dataset.state = 'setup';
        $('[data-setup]').hidden = false; $('[data-run]').hidden = true;
        $('[data-paired]').hidden = !dev; $('[data-pair-fields]').hidden = !!dev;
        if (dev) $('[data-paired-name]').textContent = dev.robot_name || dev.robot_id;
    }
    showSetup();

    const deviceName = () => {
        const ua = navigator.userAgent;
        const model = (/Android [^;]+; ([^;)]+)/.exec(ua) || [])[1] || (/iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : 'Phone');
        return `${model.trim()} (browser)`.slice(0, 80);
    };

    async function pair(robot, code) {
        const r = await fetch('/api/v1/pair', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                robot, code, agent_version: AGENT, device_kind: 'onboard', drivers: ['phone'], name: deviceName(),
                capabilities: { camera: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), speech: 'speechSynthesis' in window, tilt: 'DeviceOrientationEvent' in window },
            }),
        });
        let j = {};
        try { j = await r.json(); } catch { /* no body */ }
        if (!r.ok) throw new Error(j.detail || j.title || `pairing failed (${r.status})`);
        return { device_id: j.device_id, credential: j.credential, whip_url: j.whip_url || null, robot_id: j.robot_id, robot_name: null, profile_id: j.profile ? j.profile.id : null };
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        showError('');
        const button = form.querySelector('button[type="submit"]');
        try {
            if (!dev) {
                const robot = form.elements.robot.value.trim();
                const code = form.elements.code.value.trim();
                if (!robot || !code) return showError('Enter the robot and the pairing code from its pairing page.');
                button.disabled = true;
                dev = await pair(robot, code);
                save(dev);
            }
            front = !!form.elements.front.checked;
            await start();
        } catch (err) {
            showError(err.message || String(err));
        } finally { button.disabled = false; }
    });
    $('[data-forget]').addEventListener('click', () => {
        if (!confirm('Unpair this phone? The robot keeps its other devices; pairing again needs a new code.')) return;
        stopAll(); forget(); dev = null; showSetup();
    });
    $('[data-unpair-setup]').addEventListener('click', () => { forget(); dev = null; showSetup(); });

    // ── Running ───────────────────────────────────────────────────────────────────────────────────────────
    let ws = null; let seq = 0; let retry = 0; let running = false;
    let heartbeatMs = 1000; let heartbeatTimer = null; let telemetryTimer = null;
    let rtt = null; let remoteLatched = false; let localStop = false;
    let front = false;
    const linkEl = $('[data-link-state]');
    const videoEl = $('[data-video-state]');
    const stopBtn = $('[data-local-stop]');

    function out(type, fields = {}) {
        if (!ws || ws.readyState !== 1) return false;
        ws.send(JSON.stringify({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields }));
        return true;
    }
    function setLink(text, state) { linkEl.textContent = text; linkEl.dataset.state = state; }
    function setVideo(text, state) { videoEl.textContent = text; videoEl.dataset.state = state; }

    async function start() {
        running = true;
        main.dataset.state = 'run';
        $('[data-setup]').hidden = true; $('[data-run]').hidden = false;
        unlockAudio();
        askTilt();
        keepAwake();
        battery();
        showFace('neutral');
        connect();
        startVideo();
    }
    function stopAll() {
        running = false;
        clearInterval(heartbeatTimer); clearInterval(telemetryTimer);
        if (ws) { ws.onclose = null; try { ws.close(); } catch { /* gone */ } ws = null; }
        stopVideo();
        stopEffects();
    }

    function connect() {
        if (!running || !dev) return;
        setLink('Connecting…', 'connecting');
        ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/device`, ['ov.device', `ov.device.${dev.credential}`]);
        ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onFrame(m); };
        ws.onclose = (e) => {
            clearInterval(heartbeatTimer); clearInterval(telemetryTimer);
            stopEffects();
            if (!running) return;
            if (e.code === 4002 || e.code === 4003) {
                // The credential was revoked or rotated, or the robot was removed: this phone must pair again.
                running = false; stopVideo(); forget(); dev = null; showSetup();
                return showError('This phone is no longer paired with the robot. Ask its owner for a new pairing code.');
            }
            setLink('Reconnecting…', 'connecting');
            setTimeout(connect, Math.min(15000, 500 * 2 ** retry++) + Math.random() * 400);
        };
    }

    function onFrame(m) {
        if (m.type === 'hello') { retry = 0; return; }
        if (m.type === 'config') {
            heartbeatMs = Math.max(250, Math.min(5000, Number(m.heartbeat_ms) || 1000));
            remoteLatched = !!m.estop_latched;
            clearInterval(heartbeatTimer); clearInterval(telemetryTimer);
            heartbeatTimer = setInterval(() => out('heartbeat', { t: Date.now(), rtt_ms: rtt }), heartbeatMs);
            telemetryTimer = setInterval(sendTelemetry, 1000);
            out('status', { firmware: AGENT, capabilities: { torch: torchSupported(), speech: 'speechSynthesis' in window }, faults: faults(), estop_latched: remoteLatched || localStop });
            if (localStop) out('estop_state', { latched: true, local_stop: true, reason: 'stopped on the phone' });
            paintSafety();
            setLink('Connected', 'online');
            return;
        }
        if (m.type === 'heartbeat_ack') { if (Number.isFinite(m.echo)) rtt = Math.max(0, Date.now() - m.echo); return; }
        if (m.type === 'estop') { remoteLatched = !!m.latched; if (remoteLatched) stopEffects(); paintSafety(); return; }
        if (m.type === 'command') return onCommand(m);
        if (m.type === 'rotate') return undefined;   // a Network-paired machine's frame; a phone holds a Bot credential
        return undefined;
    }

    function onCommand(m) {
        const ack = () => out('ack', { id: m.id });
        const nack = (code) => out('nack', { id: m.id, fault_code: code });
        const v = m.value && typeof m.value === 'object' ? m.value : {};
        if (m.kind === 'halt') { stopEffects(); return ack(); }
        if (localStop) return nack('local_stop');
        if (remoteLatched) return nack('estopped');
        if (m.kind === 'say') return speak(String(v.text || '')) ? ack() : nack('unsupported');
        if (m.kind === 'display') {
            if (v.face) showFace(String(v.face)); else if (v.text) showText(String(v.text)); else return nack('invalid');
            return ack();
        }
        if (m.kind === 'actuator' && v.name === 'torch') {
            setTorch(!!v.value).then((ok) => (ok ? ack() : nack('unsupported')));
            return undefined;
        }
        if (m.kind === 'actuator' && v.name === 'chime') {
            tone(v.value && Number.isFinite(v.value.hz) ? v.value.hz : null, m.deadline_ms);
            return ack();
        }
        return nack('unsupported');
    }

    // ── The phone's own Stop ──────────────────────────────────────────────────────────────────────────────
    stopBtn.addEventListener('click', () => {
        localStop = !localStop;
        if (localStop) { stopEffects(); out('estop_state', { latched: true, local_stop: true, reason: 'stopped on the phone' }); }
        else out('estop_state', { latched: false });
        paintSafety();
    });
    function paintSafety() {
        main.dataset.stopped = String(localStop || remoteLatched);
        stopBtn.textContent = localStop ? 'Resume' : 'Stop';
        stopBtn.classList.toggle('resume', localStop);
        const note = $('[data-safety]');
        note.textContent = localStop ? 'Stopped on this phone: press Resume, then the owner clears the e-stop.' : remoteLatched ? 'The robot\'s e-stop is latched: the owner clears it on the panel.' : '';
        note.hidden = !note.textContent;
    }

    // ── Telemetry ─────────────────────────────────────────────────────────────────────────────────────────
    let tilt = null; let batt = null;
    function askTilt() {
        const listen = () => window.addEventListener('deviceorientation', (e) => {
            if (e.beta == null && e.gamma == null) return;
            tilt = { pitch: Math.round(e.beta || 0), roll: Math.round(e.gamma || 0) };
        });
        // iOS asks once, from a tap.
        if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
            DeviceOrientationEvent.requestPermission().then((s) => { if (s === 'granted') listen(); }, () => {});
        } else listen();
    }
    function battery() {
        if (!navigator.getBattery) return;
        navigator.getBattery().then((b) => {
            const read = () => { batt = { percent: Math.round(b.level * 100), charging: !!b.charging }; };
            read(); b.addEventListener('levelchange', read); b.addEventListener('chargingchange', read);
        }, () => {});
    }
    function faults() {
        const list = [];
        if (videoFault) list.push({ code: 'camera', driver: 'phone', message: videoFault });
        return list;
    }
    function sendTelemetry() {
        const frame = { sensors: tilt ? { tilt } : {} };
        if (batt) frame.battery = { percent: batt.percent };
        out('telemetry', frame);
        $('[data-rtt]').textContent = rtt == null ? '' : `${rtt} ms`;
    }

    // ── Camera over WHIP ──────────────────────────────────────────────────────────────────────────────────
    const preview = $('[data-preview]');
    let stream = null; let pc = null; let resource = null; let videoRetry = 0; let videoTimer = null; let videoFault = null;
    async function startVideo() {
        clearTimeout(videoTimer);
        if (!running) return;
        if (!dev.whip_url) { setVideo('No video on this server', 'off'); return; }
        try {
            setVideo('Starting the camera…', 'connecting');
            if (!stream) {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: front ? 'user' : 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
                    audio: false,
                });
                preview.srcObject = stream;
                preview.hidden = false;
            }
            pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
            for (const track of stream.getVideoTracks()) pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
            await pc.setLocalDescription(await pc.createOffer());
            await new Promise((done) => {
                if (pc.iceGatheringState === 'complete') return done();
                const t = setTimeout(done, 2500);
                pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); done(); } });
            });
            const r = await fetch(dev.whip_url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
            if (r.status !== 201) throw new Error(`the video server answered ${r.status}${r.headers.get('X-WHIP-ERROR') ? ` (${r.headers.get('X-WHIP-ERROR')})` : ''}`);
            resource = r.headers.get('Location') ? new URL(r.headers.get('Location'), dev.whip_url).href : null;
            await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
            pc.addEventListener('connectionstatechange', () => {
                if (pc && pc.connectionState === 'connected') { videoRetry = 0; videoFault = null; setVideo('Streaming', 'online'); }
                if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) restartVideo('the video connection dropped');
            });
        } catch (err) {
            const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
            videoFault = denied ? 'camera permission was refused' : String(err.message || err).slice(0, 160);
            setVideo(denied ? 'Camera blocked: allow it in the browser\'s site settings' : 'Camera trouble, retrying…', 'off');
            if (!denied) restartVideo(videoFault);
        }
    }
    function restartVideo(why) {
        videoFault = why;
        closePeer();
        setVideo('Reconnecting the camera…', 'connecting');
        clearTimeout(videoTimer);
        videoTimer = setTimeout(startVideo, Math.min(30000, 1000 * 2 ** videoRetry++));
    }
    function closePeer() {
        if (resource) { fetch(resource, { method: 'DELETE', keepalive: true }).catch(() => {}); resource = null; }
        if (pc) { try { pc.close(); } catch { /* gone */ } pc = null; }
    }
    function stopVideo() {
        clearTimeout(videoTimer);
        closePeer();
        if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
        preview.srcObject = null;
        preview.hidden = true;
        setVideo('', 'off');
    }
    const torchTrack = () => (stream ? stream.getVideoTracks()[0] : null);
    function torchSupported() {
        const t = torchTrack();
        const caps = t && t.getCapabilities ? t.getCapabilities() : {};
        return !!caps.torch;
    }
    async function setTorch(on) {
        const t = torchTrack();
        if (!t || !torchSupported()) return false;
        try { await t.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch { return false; }
    }

    // ── Voice, chime and face ─────────────────────────────────────────────────────────────────────────────
    let audio = null; let osc = null; let gain = null; let toneTimer = null;
    function unlockAudio() {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!audio && Ctx) { try { audio = new Ctx(); } catch { audio = null; } }
        if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
        if ('speechSynthesis' in window) speechSynthesis.getVoices();
    }
    function speak(text) {
        if (!('speechSynthesis' in window) || !text) return false;
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text.slice(0, 200));
        speechSynthesis.speak(u);
        showText(text, 4000);
        return true;
    }
    function tone(hz, deadline) {
        clearTimeout(toneTimer);
        if (!audio || hz == null) { silence(); return; }
        if (!osc) {
            osc = audio.createOscillator(); gain = audio.createGain();
            osc.type = 'triangle'; gain.gain.value = 0;
            osc.connect(gain).connect(audio.destination); osc.start();
        }
        osc.frequency.setValueAtTime(hz, audio.currentTime);
        gain.gain.setTargetAtTime(0.25, audio.currentTime, 0.01);
        const until = Number.isFinite(deadline) ? Math.max(50, deadline - Date.now()) : 400;
        toneTimer = setTimeout(silence, until);   // the chime's deadman: held means re-sent
    }
    function silence() {
        clearTimeout(toneTimer);
        if (osc && audio) { gain.gain.setTargetAtTime(0, audio.currentTime, 0.02); const o = osc; osc = null; setTimeout(() => { try { o.stop(); } catch { /* stopped */ } }, 120); }
    }
    function stopEffects() {
        silence();
        if ('speechSynthesis' in window) speechSynthesis.cancel();
        setTorch(false);
    }

    const face = $('[data-face]');
    const SVG = 'http://www.w3.org/2000/svg';
    const el = (name, attrs) => { const n = document.createElementNS(SVG, name); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    // Each face: two eyes and a mouth on a 200×120 box.
    const EYE = { cx: [62, 138], cy: 46 };
    const FACES = {
        neutral: { eyes: 'round', mouth: 'M70 92 L130 92' },
        happy: { eyes: 'round', mouth: 'M64 84 Q100 116 136 84' },
        sad: { eyes: 'round', mouth: 'M66 100 Q100 74 134 100' },
        surprised: { eyes: 'wide', mouth: 'circle' },
        sleepy: { eyes: 'closed', mouth: 'M84 94 L116 94' },
        wink: { eyes: 'wink', mouth: 'M64 84 Q100 112 136 84' },
        love: { eyes: 'heart', mouth: 'M64 84 Q100 116 136 84' },
        angry: { eyes: 'angry', mouth: 'M66 100 Q100 80 134 100' },
    };
    let textTimer = null;
    function showFace(name) {
        clearTimeout(textTimer);
        const f = FACES[name] || FACES.neutral;
        const svg = el('svg', { viewBox: '0 0 200 120', role: 'img', 'aria-label': `${name} face` });
        const stroke = { stroke: 'currentColor', 'stroke-width': 8, 'stroke-linecap': 'round', fill: 'none' };
        EYE.cx.forEach((cx, i) => {
            if (f.eyes === 'closed' || (f.eyes === 'wink' && i === 1)) svg.append(el('path', { d: `M${cx - 16} ${EYE.cy} Q${cx} ${EYE.cy + 12} ${cx + 16} ${EYE.cy}`, ...stroke }));
            else if (f.eyes === 'heart') svg.append(el('path', { d: `M${cx} ${EYE.cy + 14} L${cx - 16} ${EYE.cy - 2} A8 8 0 0 1 ${cx} ${EYE.cy - 10} A8 8 0 0 1 ${cx + 16} ${EYE.cy - 2} Z`, fill: '#ff5c8a' }));
            else {
                svg.append(el('circle', { cx, cy: EYE.cy, r: f.eyes === 'wide' ? 17 : 13, fill: 'currentColor' }));
                if (f.eyes === 'angry') svg.append(el('path', { d: i === 0 ? `M${cx - 20} ${EYE.cy - 26} L${cx + 14} ${EYE.cy - 14}` : `M${cx + 20} ${EYE.cy - 26} L${cx - 14} ${EYE.cy - 14}`, ...stroke }));
            }
        });
        svg.append(f.mouth === 'circle' ? el('circle', { cx: 100, cy: 94, r: 11, ...stroke }) : el('path', { d: f.mouth, ...stroke }));
        face.replaceChildren(svg);
        face.dataset.mode = 'face';
    }
    function showText(text, ms = 0) {
        clearTimeout(textTimer);
        const p = document.createElement('p');
        p.className = 'phone-text';
        p.textContent = text.slice(0, 200);
        p.style.fontSize = `${Math.max(5, Math.min(18, 160 / Math.max(6, text.length)))}vmin`;
        face.replaceChildren(p);
        face.dataset.mode = 'text';
        if (ms) textTimer = setTimeout(() => showFace('neutral'), ms);
    }

    // ── Keep the screen on while running ──────────────────────────────────────────────────────────────────
    let wake = null;
    async function keepAwake() {
        if (!('wakeLock' in navigator) || !running) return;
        try { wake = await navigator.wakeLock.request('screen'); } catch { wake = null; }
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden && running) keepAwake(); });
    window.addEventListener('pagehide', closePeer);   // ends the WHIP session (keepalive) so the panel's video stops at once
})();
