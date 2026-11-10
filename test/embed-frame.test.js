'use strict';
// The embeddable panel's frame adapter (public/embed-frame.js): the page around the frame hands it the theme
// tokens and asks for its height. Only a plain colour is ever applied, only from the page that already frames it
// (data-parent-origins / BOT_EMBED_ORIGINS), and the height goes out on load and on a change, at most 5×/s.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { check, done } = require('./helpers/app');
const EmbedFrame = require('../public/embed-frame.js');
const { renderPanel, renderEmbedRefused } = require('../server/web/render');

// A window just big enough for start(): listeners, a parent, a document with a size, and a fake ResizeObserver.
function fakeWin({ height = 300 } = {}) {
    const posted = [];
    const parent = { postMessage: (msg, origin) => posted.push([msg, origin]) };
    const listeners = new Map();
    const props = {};
    const attrs = {};
    const timers = new Map();
    let nextTimer = 0;
    const html = {
        style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } },
        setAttribute: (k, v) => { attrs[k] = String(v); },
        getAttribute: (k) => (k in attrs ? attrs[k] : null),
    };
    const body = { scrollHeight: height, getBoundingClientRect: () => ({ height }) };
    let observer = null;
    const win = {
        document: { documentElement: html, body },
        parent,
        addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
        removeEventListener(type, fn) { if (listeners.has(type)) listeners.get(type).delete(fn); },
        setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: Date.now() + ms }); return id; },
        clearTimeout(id) { timers.delete(id); },
        ResizeObserver: class { constructor(cb) { this.cb = cb; observer = this; } observe() {} disconnect() { this.gone = true; } },
    };
    win.__posted = posted;
    win.__props = props;
    win.__attrs = attrs;
    win.__listeners = listeners;
    win.__timers = timers;
    win.__observer = () => observer;
    win.__fire = (type, event) => { for (const fn of [...(listeners.get(type) || [])]) fn(event); };
    win.__setHeight = (h) => { body.scrollHeight = h; };
    win.__tick = () => { for (const [id, t] of [...timers]) if (t.at <= Date.now()) { timers.delete(id); t.fn(); } };
    return win;
}

const PARENT = 'https://openvibe.live';
const themeMessage = (tokens, extra = {}) => ({ type: 'ov-bot-theme', robot_id: 'rob_x', tokens, ...extra });

(async () => {
    await check('validColor: plain hex and functional colours pass; anything else is refused', () => {
        for (const ok of ['#fff', '#ffff', '#0a0f1c', '#0a0f1cff', 'rgb(1, 2, 3)', 'rgb(1 2 3 / 50%)', 'rgba(1,2,3,.5)', 'hsl(210 40% 50%)', 'oklch(0.7 0.1 200)']) {
            assert.ok(EmbedFrame.validColor(ok), ok);
        }
        for (const bad of ['', 'red', 'var(--x)', 'color-mix(in srgb, red, blue)', 'url(https://evil.example/x)', 'rgb(1,2,3);--x:y', '#12', '#12345', 'hsl(1 2 3) ; background: url(x)', 123, null, {}, 'x'.repeat(65)]) {
            assert.ok(!EmbedFrame.validColor(bad), JSON.stringify(bad));
        }
        assert.strictEqual(EmbedFrame.validScheme('light'), 'light');
        assert.strictEqual(EmbedFrame.validScheme('Light'), null);
        assert.strictEqual(EmbedFrame.validScheme('dark'), 'dark');
        assert.strictEqual(EmbedFrame.validScheme('auto'), null);
    });

    await check('sanitizeTokens: only the known names with a plain colour survive', () => {
        const out = EmbedFrame.sanitizeTokens({
            '--bg-primary': '#0a0f1c', '--text-secondary': 'rgb(1, 2, 3)',
            '--accent': 'url(https://evil.example/a)', '--border': 12, '--nope': '#fff',
            '__proto__': '#fff', '--bg-card': 'color-mix(in srgb, red, blue)',
        });
        assert.deepStrictEqual(out, { '--bg-primary': '#0a0f1c', '--text-secondary': 'rgb(1, 2, 3)' });
        assert.deepStrictEqual(EmbedFrame.sanitizeTokens(null), {});
        assert.deepStrictEqual(EmbedFrame.sanitizeTokens(['#fff']), {});
    });

    await check('embed page: the frame adapter is loaded for the embed only, with the trusted origins on the panel', () => {
        const profile = { id: 'sim.rover', name: 'Rover', commands: { drive: { axes: { throttle: [-1, 1], steer: [-1, 1] } } }, widgets: [] };
        const robot = { id: 'rob_x1', name: 'Rover', profile_id: 'sim.rover', estop: { latched: false } };
        const embed = renderPanel({ robot, profile, role: 'watcher', allowed_commands: [], mode: 'embed', signedIn: false, parentOrigins: [PARENT, 'https://www.openvibe.live'] });
        const at = (s) => embed.indexOf(s);
        assert.ok(embed.includes('<html lang="en" class="embed-page">'), 'the embed follows prefers-color-scheme before the first token message');
        assert.ok(embed.includes('<meta name="color-scheme" content="dark light">'));
        assert.ok(at('/panel/embed-frame.js') > 0 && at('/panel/embed-frame.js') < at('/panel/panel.js'), 'the adapter loads before the panel client');
        assert.ok(embed.includes('data-parent-origins="https://openvibe.live https://www.openvibe.live"'));
        const page = renderPanel({ robot, profile, role: 'owner', allowed_commands: ['drive'] });
        assert.ok(!page.includes('embed-frame.js') && page.includes('<html lang="en">') && page.includes('<meta name="color-scheme" content="dark">'));
        const refused = renderEmbedRefused({ robotId: 'rob_x1', parentOrigins: [PARENT] });
        assert.ok(refused.includes('class="embed-page"') && refused.includes('content="dark light"') && !refused.includes('embed-frame.js'));
        const route = fs.readFileSync(path.join(__dirname, '..', 'server', 'web', 'routes.js'), 'utf8');
        assert.ok(route.includes("r.get('/panel/embed-frame.js', asset('embed-frame.js', 'application/javascript'));"));
    });

    await check('start(): the height goes on load, and only a trusted, framing origin can set the colours', () => {
        const win = fakeWin({ height: 321 });
        const stop = EmbedFrame.start({ win, parents: [PARENT], robotId: 'rob_x' });
        assert.deepStrictEqual(win.__posted, [[{ type: 'ov-bot-size', robot_id: 'rob_x', height: 321 }, PARENT]], 'one size on start, to the trusted origin');

        // A stranger's message (another origin, another window, another robot) changes nothing.
        win.__fire('message', { origin: 'https://evil.example', source: win.parent, data: themeMessage({ '--bg-primary': '#111111' }) });
        win.__fire('message', { origin: PARENT, source: {}, data: themeMessage({ '--bg-primary': '#222222' }) });
        win.__fire('message', { origin: PARENT, source: win.parent, data: themeMessage({ '--bg-primary': '#333333' }, { robot_id: 'rob_other' }) });
        win.__fire('message', { origin: PARENT, source: win.parent, data: { type: 'ov-bot-ticket', robot_id: 'rob_x' } });
        assert.deepStrictEqual(win.__props, {}, 'nothing applied');

        win.__fire('message', { origin: PARENT, source: win.parent, data: themeMessage({
            '--bg-primary': '#0a0f1c', '--bg-card': '#131c2e', '--text-primary': '#e6edf7', '--text-secondary': '#96a7c2',
            '--accent': 'rgb(59, 130, 246)', '--accent-strong': '#3472d8', '--on-accent-strong': '#ffffff', '--border': '#1f2d47',
            '--color-scheme': 'light',
        }) });
        assert.strictEqual(win.__props['--bg-primary'], '#0a0f1c');
        assert.strictEqual(win.__props['--accent'], 'rgb(59, 130, 246)');
        assert.strictEqual(win.__props['--color-scheme'], 'light');
        assert.strictEqual(win.__attrs['data-theme-mode'], 'light');
        stop();
        assert.strictEqual(win.__listeners.get('message').size, 0);
    });

    await check('start(): a size change arrives, throttled to about five a second, and the last one always goes', async () => {
        const win = fakeWin({ height: 300 });
        const stop = EmbedFrame.start({ win, parents: [PARENT], robotId: 'rob_x' });
        assert.strictEqual(win.__posted.length, 1);
        win.__setHeight(420);
        for (let i = 0; i < 4; i++) win.__observer().cb();   // rapid changes: one trailing send, not four
        assert.strictEqual(win.__posted.length, 1, 'nothing sooner than 200 ms');
        await new Promise((r) => setTimeout(r, 220));
        win.__tick();
        assert.deepStrictEqual(win.__posted.at(-1)[0], { type: 'ov-bot-size', robot_id: 'rob_x', height: 420 });
        assert.ok(win.__posted.length <= 3, `at most about five a second, got ${win.__posted.length}`);
        win.__setHeight(300);
        win.__fire('resize', {});
        await new Promise((r) => setTimeout(r, 220));
        win.__tick();
        assert.strictEqual(win.__posted.at(-1)[0].height, 300, 'a shrinking panel reports the smaller height too');
        stop();
        assert.strictEqual(win.__observer().gone, true, 'stop() disconnects the observer');
        assert.strictEqual(win.__listeners.get('resize').size, 0);
    });

    await check('start(): an unframed page or one with no trusted parents does nothing', () => {
        const unframed = fakeWin();
        unframed.parent = unframed;
        assert.strictEqual(typeof EmbedFrame.start({ win: unframed, parents: [PARENT] }), 'function');
        assert.deepStrictEqual(unframed.__posted, []);
        const alone = fakeWin();
        EmbedFrame.start({ win: alone, parents: [] })();
        assert.deepStrictEqual(alone.__posted, []);
    });

    done();
})();
