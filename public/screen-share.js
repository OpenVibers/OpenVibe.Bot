/* A shared screen with "use" (server/screen-shares.js, /screen/:token): start or stop the screen, and with "Use the mouse
   and keyboard" on, clicks, double clicks, right clicks, the wheel and keys on the picture go to the computer as input
   commands. Positions are in the picture's own pixels (the computer scales them to its screen). Plain text is sent in
   short bursts as typed text; other keys and chords by name (Return, BackSpace, ctrl+c). panel.js plays the picture. */
(function () {
    'use strict';
    const main = document.querySelector('main[data-share]');
    if (!main || main.dataset.control !== '1') return;
    const base = main.dataset.share;
    const fig = main.querySelector('[data-screen-state]');
    const use = main.querySelector('[data-share-use]');
    const startBtn = main.querySelector('[data-share-start]');
    const stopBtn = main.querySelector('[data-share-stop]');
    const note = main.querySelector('[data-share-note]');
    const say = (t) => { if (note) note.textContent = t || ''; };

    async function post(path, body) {
        const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}), credentials: 'omit' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.detail || ('the computer answered ' + r.status));
        return j;
    }

    // Start when the screen is off; the state comes from the same JSON panel.js reads.
    async function refresh() {
        try {
            const r = await fetch(base + '/state.json', { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'omit' });
            const s = r.ok ? await r.json() : null;
            if (startBtn) startBtn.hidden = !s || s.live || !s.online;
            if (s && !s.online) say('The computer is offline.');
        } catch (e) { /* the next look tries again */ }
    }
    refresh();
    setInterval(refresh, 5000);
    if (startBtn) startBtn.addEventListener('click', async () => {
        startBtn.disabled = true; say('Starting the screen…');
        try { await post('/start'); say('Starting: the picture appears in a few seconds.'); } catch (e) { say(e.message); } finally { startBtn.disabled = false; refresh(); }
    });
    if (stopBtn) stopBtn.addEventListener('click', async () => {
        try { await post('/stop'); say('The screen is stopped.'); } catch (e) { say(e.message); } finally { refresh(); }
    });

    const on = () => !!(use && use.checked);
    if (use) use.addEventListener('change', () => { fig.classList.toggle('share-using', on()); if (on()) { fig.focus(); say('Clicks and keys on the picture go to the computer.'); } else say(''); });

    /** A pointer position → the picture's own pixels, allowing for the letterboxing of object-fit: contain. */
    function at(ev) {
        const v = fig.querySelector('video');
        if (!v || !v.videoWidth) return null;
        const r = v.getBoundingClientRect();
        const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        const ox = (r.width - v.videoWidth * scale) / 2;
        const oy = (r.height - v.videoHeight * scale) / 2;
        const x = Math.round((ev.clientX - r.left - ox) / scale);
        const y = Math.round((ev.clientY - r.top - oy) / scale);
        if (x < 0 || y < 0 || x > v.videoWidth || y > v.videoHeight) return null;
        return { x, y, width: v.videoWidth, height: v.videoHeight };
    }
    let busy = Promise.resolve();
    const send = (value) => { busy = busy.then(() => post('/input', value).then(() => say(''), (e) => say(e.message))); return busy; };

    let clickTimer = null;
    fig.addEventListener('click', (ev) => {
        if (!on()) return;
        const p = at(ev); if (!p) return;
        ev.preventDefault();
        // A double click arrives as two clicks first: wait a moment so it is sent once, as a double click.
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => send({ action: 'click', ...p }), 220);
    });
    fig.addEventListener('dblclick', (ev) => {
        if (!on()) return;
        const p = at(ev); if (!p) return;
        ev.preventDefault(); clearTimeout(clickTimer);
        send({ action: 'double_click', ...p });
    });
    fig.addEventListener('contextmenu', (ev) => {
        if (!on()) return;
        const p = at(ev); if (!p) return;
        ev.preventDefault();
        send({ action: 'right_click', ...p });
    });
    let wheel = 0, wheelTimer = null, wheelAt = null;
    fig.addEventListener('wheel', (ev) => {
        if (!on()) return;
        const p = at(ev); if (!p) return;
        ev.preventDefault();
        wheel += ev.deltaY; wheelAt = p;
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => { const dy = Math.max(-20, Math.min(20, Math.round(wheel / 60))); wheel = 0; if (dy) send({ action: 'scroll', ...wheelAt, dy }); }, 150);
    }, { passive: false });

    const NAMES = { Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next', Insert: 'Insert', ' ': 'space' };
    let text = '', textTimer = null;
    const flush = () => { if (text) { const t = text; text = ''; send({ action: 'type', text: t }); } };
    fig.addEventListener('keydown', (ev) => {
        if (!on()) return;
        const mods = [ev.ctrlKey && 'ctrl', ev.altKey && 'alt', ev.metaKey && 'super'].filter(Boolean);
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(ev.key)) return;
        ev.preventDefault();
        if (!mods.length && ev.key.length === 1) {
            text += ev.key;
            clearTimeout(textTimer);
            textTimer = setTimeout(flush, 120);
            return;
        }
        flush();
        let name = NAMES[ev.key] || (/^F\d{1,2}$/.test(ev.key) ? ev.key : (ev.key.length === 1 ? ev.key.toLowerCase() : null));
        if (!name || !/^[A-Za-z0-9_]+$/.test(name)) return;
        if (ev.shiftKey && mods.length) mods.push('shift');
        send({ action: 'key', keys: [...mods, name].join('+') });
    });
})();
