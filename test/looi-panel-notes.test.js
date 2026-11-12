'use strict';
// public/panel.js on a LOOI panel: the battery row's freshness note and the Operators card's one line about the
// robot's own view. The client is run in a small DOM with the same data-* hooks the server draws; no browser.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, done } = require('./helpers/app');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.js'), 'utf8');
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

/** A Date whose "now" is fixed, so "updated Ns ago" is exact. */
class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(NOW); }
    static now() { return NOW; }
}

function el(tag, attrs = {}) {
    return {
        tagName: tag.toUpperCase(), dataset: { ...attrs }, hidden: false, textContent: '', value: '',
        style: { setProperty() {} },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
        querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
        contains() { return false; }, focus() {}, blur() {}, appendChild() {}, remove() {},
        getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    };
}

function panelPage() {
    const main = el('main', { robotId: 'rob_looi', role: 'owner', allowed: '[]', holdMs: '150' });
    const battery = el('meter');
    const batteryText = el('output');
    const batteryNote = el('span');
    const batteryFreshness = el('span');
    const robotLine = el('p');
    const headRange = el('span');
    const onlinePill = el('span');
    const onlineLabel = el('span');
    const clock = { t: 0 };
    const opsCard = el('section');
    opsCard.querySelector = (sel) => (sel === '[data-operators-robot]' ? robotLine : null);
    const selectors = {
        '[data-battery]': [battery],
        '[data-battery-text]': [batteryText],
        '[data-battery-note]': [batteryNote],
        '[data-battery-freshness]': [batteryFreshness],
        '[data-head-range]': [headRange],
    };
    const one = { '[data-operators]': opsCard, '[data-online-pill]': onlinePill, '[data-online-label]': onlineLabel };
    const document = {
        getElementById: (id) => (id === 'panel' ? main : null),
        querySelector: (sel) => one[sel] || null,
        querySelectorAll: (sel) => selectors[sel] || [],
        createElement: (tag) => el(tag),
        addEventListener() {}, head: el('head'), hidden: false, activeElement: null, hasFocus: () => true,
    };
    const sockets = [];
    class WebSocket {
        constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
        send() {} close() {} addEventListener() {} removeEventListener() {}
    }
    WebSocket.OPEN = 1;
    class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
    const ctx = {
        document, WebSocket, CustomEvent, console, Promise, JSON, Math, Date: FakeDate, URL, Number, String,
        Object, Array, Set, Map, Error, CSS: { escape: (s) => s }, performance: { now: () => clock.t },
        location: { protocol: 'https:', host: 'openvibe.bot' }, navigator: {},
        setTimeout: (fn) => { void fn; return 0; }, clearTimeout() {},
        setInterval: () => 0, clearInterval() {},
        requestAnimationFrame() {}, fetch: async () => ({ ok: false, json: async () => ({}) }),
        addEventListener() {}, dispatchEvent() {}, MediaStream: class {},
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(SOURCE, ctx, { filename: 'panel.js' });
    const socket = sockets[0];
    assert.ok(socket, 'the panel opened /control');
    const send = (m) => socket.onmessage({ data: JSON.stringify(m) });
    const state = (s) => send({ type: 'robot_state', state: { online: true, ...s } });
    return { state, send, battery, batteryText, batteryNote, batteryFreshness, robotLine, headRange, onlinePill, onlineLabel, clock };
}

(async () => {
    await check('the battery row says read at connect, updated Ns/min ago, or nothing; a missing reading is a dash and unknown', () => {
        const page = panelPage();
        page.state({ battery: 0.42, telemetry: { sensors: { p7_battery: { pct: 42, unverified: true, at: iso(NOW - 500) } } } });
        assert.strictEqual(page.batteryText.textContent, '42 %');
        assert.strictEqual(page.batteryNote.hidden, true);
        assert.strictEqual(page.batteryFreshness.textContent, 'read at connect');
        assert.strictEqual(page.batteryFreshness.hidden, false);
        page.state({ battery: 0.42, telemetry: { sensors: { p7_battery: { pct: 42, at: iso(NOW - 12300) } } } });
        assert.strictEqual(page.batteryFreshness.textContent, 'updated 12s ago');
        assert.strictEqual(page.batteryFreshness.hidden, false);
        page.state({ battery: 0.42, telemetry: { sensors: { p7_battery: { pct: 42, at: NOW - 125000 } } } });
        assert.strictEqual(page.batteryFreshness.textContent, 'updated 2m ago', 'the same note in minutes');
        page.state({ battery: 0.42, telemetry: { sensors: { p7_battery: { pct: 42 } } } });
        assert.strictEqual(page.batteryFreshness.textContent, '');
        assert.strictEqual(page.batteryFreshness.hidden, true, 'no at and not unverified: no note');
        page.state({ battery: null, telemetry: { sensors: { p7_battery: { unverified: true, at: iso(NOW - 1000) } } } });
        assert.strictEqual(page.batteryText.textContent, '—');
        assert.strictEqual(page.batteryNote.textContent, 'unknown');
        assert.strictEqual(page.batteryNote.hidden, false);
        assert.strictEqual(page.batteryFreshness.hidden, true, 'a missing reading has no freshness note');
    });

    await check('a polled reading says provisional, updated Ns ago (source poll, Maticus 11-12)', () => {
        const page = panelPage();
        page.state({ battery: 0.6, telemetry: { sensors: { p7_battery: { pct: 60, usb: false, raw: 153, unverified: true, source: 'poll', at: iso(NOW - 7400) } } } });
        assert.strictEqual(page.batteryFreshness.textContent, 'provisional, updated 7s ago');
        page.state({ battery: 0.6, telemetry: { sensors: { p7_battery: { pct: 60, unverified: true, source: 'poll', at: NOW - 180000 } } } });
        assert.strictEqual(page.batteryFreshness.textContent, 'provisional, updated 3m ago');
        page.state({ battery: 0.6, telemetry: { sensors: { p7_battery: { pct: 60, unverified: true, at: iso(NOW - 500) } } } });
        assert.strictEqual(page.batteryFreshness.textContent, 'read at connect', 'a read at connect still says so');
    });

    await check('the head slider names its mounting: Portrait and its range, or Landscape; nothing without p7_head', () => {
        const page = panelPage();
        page.state({ telemetry: { sensors: { p7_head: { orientation: 'portrait', min: 0, max: 200, center: 90 } } } });
        assert.strictEqual(page.headRange.textContent, 'Portrait · 0–200, centre 90');
        assert.strictEqual(page.headRange.hidden, false);
        assert.strictEqual(page.headRange.dataset.orientation, 'portrait');
        page.state({ telemetry: { sensors: { p7_head: { orientation: 'landscape', min: 0, max: 255, center: 90 } } } });
        assert.strictEqual(page.headRange.textContent, 'Landscape · 0–255, centre 90');
        page.state({ telemetry: { sensors: {} } });
        assert.strictEqual(page.headRange.hidden, true);
        page.state({ telemetry: { sensors: { p7_head: { orientation: 'sideways', min: 0, max: 9 } } } });
        assert.strictEqual(page.headRange.hidden, true, 'an orientation it does not know is not shown');
    });

    await check('a Bot restart reads Reconnecting… for a moment, not Device offline (Maticus 11-12: close 1012 every deploy)', () => {
        const page = panelPage();
        page.clock.t = 1000;
        page.state({ online: true });
        assert.strictEqual(page.onlineLabel.textContent, 'Online');
        page.clock.t = 3000;
        page.state({ online: false });
        assert.deepStrictEqual([page.onlineLabel.textContent, page.onlinePill.dataset.state], ['Reconnecting…', 'disconnected'], 'two seconds after it was online');
        page.clock.t = 3800;
        page.state({ online: true });
        assert.strictEqual(page.onlineLabel.textContent, 'Online', 'and back');
        page.clock.t = 19000;
        page.state({ online: true });
        page.clock.t = 20000;
        page.state({ online: false });
        assert.strictEqual(page.onlineLabel.textContent, 'Reconnecting…');
        page.clock.t = 29000;
        page.state({ online: false });
        assert.deepStrictEqual([page.onlineLabel.textContent, page.onlinePill.dataset.state], ['Device offline', 'offline'], 'gone longer than the grace: offline');
        const fresh = panelPage();
        fresh.clock.t = 500;
        fresh.state({ online: false });
        assert.strictEqual(fresh.onlineLabel.textContent, 'Device offline', 'a robot never seen online is plainly offline');
    });

    await check('the Operators card says The robot follows: name (channel) only while the robot view is fresh', () => {
        const page = panelPage();
        const view = (at, source = 'robot', channel = 'head') => ({
            type: 'operators_state',
            operators: {
                sole: null, viewers: 0, now: iso(NOW),
                members: [{ subject: 'bob', role: 'operator', enabled: true }],
                activity: { bob: { last: { kind: channel, channel, at: iso(at), source }, [`${channel}_at`]: iso(at) } },
            },
        });
        page.send(view(NOW - 1000));
        assert.strictEqual(page.robotLine.textContent, 'The robot follows: bob (head)');
        assert.strictEqual(page.robotLine.hidden, false);
        page.send(view(NOW - 1000, 'robot', 'lights'));
        assert.strictEqual(page.robotLine.textContent, 'The robot follows: bob (lights)');
        page.send(view(NOW - 6000));
        assert.strictEqual(page.robotLine.textContent, '');
        assert.strictEqual(page.robotLine.hidden, true, 'an older robot view is not shown');
        page.send(view(NOW - 1000, 'bot'));
        assert.strictEqual(page.robotLine.textContent, '');
        assert.strictEqual(page.robotLine.hidden, true, 'Bot\'s own stamp is not the robot\'s view');
    });

    done();
})();
