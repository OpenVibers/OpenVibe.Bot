'use strict';
// public/panel.js on a page with no robot panel (a machine's live screen, /machines/:id/screen): the tile polls the
// machine's screen.json until the machine publishes, then opens the session's viewer signaling socket; once the
// machine stops, it says so and stops reconnecting. The live video must not wait for #panel, which only a robot's
// panel has (2026-10-15: it did, and the screen page stayed on "Waiting for the machine…").
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, done } = require('./helpers/app');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.js'), 'utf8');

/** Just enough DOM to run panel.js on the screen page: one tile, its placeholder lines and its status line. */
function screenPage(states) {
    const el = (tag, attrs = {}) => ({
        tagName: tag.toUpperCase(), dataset: { ...attrs }, hidden: false, textContent: '', children: [], parentElement: null,
        appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
        remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((x) => x !== this); },
        addEventListener() {}, setAttribute() {}, removeAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; },
        play() { return Promise.resolve(); },
    });
    const status = el('p');
    status.textContent = 'Waiting for the machine…';
    const screen = el('div');
    screen.appendChild(el('svg'));
    screen.appendChild(status);
    const tile = el('figure', { screenState: '/machines/dev_1/screen.json' });
    tile.appendChild(screen);
    const find = (root, sel) => {
        if (sel === '[data-camera-screen]') return screen;
        if (sel === '[data-screen-status]') return status;
        if (sel === 'video') return screen.children.find((c) => c.tagName === 'VIDEO') || null;
        return null;
    };
    tile.querySelector = (sel) => find(tile, sel);
    const document = {
        getElementById: () => null,
        querySelector: (sel) => (sel === '[data-screen-state]' ? tile : find(document, sel)),
        querySelectorAll: (sel) => (sel === '[data-screen-state]' ? [tile] : []),
        createElement: (tag) => el(tag),
        addEventListener() {}, hidden: false,
    };
    const sockets = [];
    class WebSocket {
        constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; sockets.push(this); }
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
        send() {}
        close() { this.closed = true; }
    }
    WebSocket.OPEN = 1;
    const polled = [];
    const timers = [];
    const ctx = {
        document, WebSocket, console, Promise, JSON, Math, Date, URL, Number, String, Object, Array, Set, Map, Error,
        location: { protocol: 'https:', host: 'openvibe.bot' }, navigator: {},
        MediaStream: class {}, window: {},
        fetch: async (url) => { polled.push(url); const s = states.shift() || { live: false, state: 'off', online: true }; return { ok: true, json: async () => s }; },
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeout: () => {},
        addEventListener() {}, requestAnimationFrame() {},
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(SOURCE, ctx, { filename: 'panel.js' });
    const settle = () => new Promise((r) => setImmediate(r));
    // tick: the next scheduled poll runs (the page's own timers fire only here), then its fetch settles.
    const tick = async () => { const due = timers.splice(0); for (const t of due) t.fn(); await settle(); await settle(); };
    return { status, sockets, polled, tick, settle, screen };
}

(async () => {
    await check('the screen page waits, then opens the session\'s viewer socket — with no #panel on the page', async () => {
        const page = screenPage([
            { live: false, signaling_url: null, state: 'off', online: true },
            { live: true, signaling_url: 'wss://ingest.openre.stream/w/ses_X', state: 'live', online: true },
        ]);
        await page.settle();
        await page.settle();
        assert.deepStrictEqual(page.polled, ['/machines/dev_1/screen.json'], 'it asks at once');
        assert.strictEqual(page.status.textContent, 'Waiting for the machine…');
        assert.strictEqual(page.sockets.length, 0);
        await page.tick();
        assert.strictEqual(page.polled.length, 2);
        assert.strictEqual(page.status.textContent, 'Connecting to the screen…');
        assert.deepStrictEqual(page.sockets.map((s) => s.url), ['wss://ingest.openre.stream/w/ses_X'], 'the viewer socket, to the session\'s signaling URL');
        assert.ok(page.screen.children.some((c) => c.tagName === 'VIDEO'), 'a video element in the tile');
    });

    await check('an offline machine says so; one that stops says the screen is no longer shown and stops polling', async () => {
        const offline = screenPage([{ live: false, signaling_url: null, state: 'off', online: false }]);
        await offline.settle();
        await offline.settle();
        assert.strictEqual(offline.status.textContent, 'The machine is offline.');
        const page = screenPage([
            { live: true, signaling_url: 'wss://ingest.openre.stream/w/ses_Y', state: 'live', online: true },
            { live: false, signaling_url: null, state: 'off', online: true },
        ]);
        await page.settle();
        await page.settle();
        assert.strictEqual(page.status.textContent, 'Connecting to the screen…');
        await page.tick();
        assert.strictEqual(page.status.textContent, 'Your screen is no longer shown.');
        const asked = page.polled.length;
        await page.tick();
        await page.tick();
        assert.strictEqual(page.polled.length, asked, 'no more polling');
        assert.ok(page.screen.children.filter((c) => c.tagName === 'VIDEO').every((c) => c.hidden), 'the video is hidden, the placeholder back');
        assert.ok(page.sockets.every((s) => s.closed), 'the viewer socket is closed');
    });

    done();
})();
