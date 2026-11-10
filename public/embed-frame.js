'use strict';

/**
 * The embeddable panel's frame adapter (plan T15: "the robot control is not perfected … fit any page it is placed in").
 *
 * The page around the frame (OpenVibe.Live's public/js/bot-embed.js) owns the look and the height:
 *
 *   ov-bot-theme  { tokens: { '--bg-primary', '--bg-card', '--text-primary', '--text-secondary', '--accent',
 *                             '--accent-strong', '--on-accent-strong', '--border', '--color-scheme' } }
 *                 → set each valid plain colour on <html>; --color-scheme must be 'dark' or 'light'.
 *   ov-bot-size   { height } ← the embed's own content height, sent on load and when it changes, at most five
 *                 times a second (a trailing edge, so the last size always goes).
 *
 * Only the origins already trusted for the panel's other messages (the page's data-parent-origins, from
 * BOT_EMBED_ORIGINS) and only the window that frames it are accepted; a message from anywhere else is ignored.
 * Until one arrives, public/panel.css follows prefers-color-scheme with the network's default (Vibe / cloud).
 *
 * Plain script for the browser (window.EmbedFrame) and require() for the tests.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.EmbedFrame = api;
})(typeof self !== 'undefined' ? self : this, function () {
    const TOKENS = ['--bg-primary', '--bg-card', '--text-primary', '--text-secondary', '--accent', '--accent-strong', '--on-accent-strong', '--border'];
    const MAX_LEN = 64;
    // Plain colours only: hex (3/4/6/8), or the functional notations a computed style may give. No var(), calc(),
    // url(), color-mix(), named colours or anything that could carry a second declaration.
    const COLOR_RE = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(\s*[0-9a-z.%+\-\s,/]+\))$/i;
    const SIZE_GAP_MS = 200;   // five a second

    function validColor(value) {
        return typeof value === 'string' && value.length <= MAX_LEN && COLOR_RE.test(value.trim());
    }

    /** 'dark' | 'light' | null. */
    function validScheme(value) {
        return value === 'dark' || value === 'light' ? value : null;
    }

    /** The tokens worth applying: only the known names, only plain colours, never inherited keys. */
    function sanitizeTokens(tokens) {
        const out = {};
        if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return out;
        for (const name of TOKENS) {
            if (Object.prototype.hasOwnProperty.call(tokens, name) && validColor(tokens[name])) out[name] = tokens[name].trim();
        }
        return out;
    }

    function validOrigin(value) {
        if (typeof value !== 'string' || !value) return false;
        try {
            const u = new URL(value);
            return !u.username && !u.password && u.search === '' && u.hash === '' && (u.pathname === '' || u.pathname === '/') && u.origin === value;
        } catch { return false; }
    }

    /**
     * start({ win, parents, robotId })  → stop(). `parents` is the page's data-parent-origins list (server:
     * BOT_EMBED_ORIGINS). Nothing starts without one: an unframed or untrusted page is left alone.
     */
    function start({ win = typeof window !== 'undefined' ? window : null, parents = [], robotId = null } = {}) {
        const doc = win && win.document;
        const html = doc && doc.documentElement;
        const targets = parents.filter(validOrigin);
        if (!win || !doc || !html || !targets.length || win.parent === win) return () => {};

        const robot = typeof robotId === 'string' ? robotId : null;
        let stopAt = 0;
        let timer = 0;
        let lastHeight = -1;

        const measure = () => {
            const body = doc.body;
            if (!body) return 0;
            let height = 0;
            try {
                height = Math.max(height, body.scrollHeight || 0, Math.ceil(body.getBoundingClientRect().height));
            } catch { /* a document going away */ }
            return Math.max(0, Math.ceil(height));
        };
        const post = (message) => {
            for (const origin of targets) {
                try { win.parent.postMessage(message, origin); } catch { /* not that origin */ }
            }
        };
        const send = (force) => {
            const now = Date.now();
            const wait = SIZE_GAP_MS - (now - stopAt);
            if (!force && wait > 0) {
                if (!timer) timer = win.setTimeout(() => { timer = 0; send(true); }, wait);
                return;
            }
            if (timer) { win.clearTimeout(timer); timer = 0; }
            const height = measure();
            if (!force && height === lastHeight) return;
            stopAt = now;
            lastHeight = height;
            post(robot ? { type: 'ov-bot-size', robot_id: robot, height } : { type: 'ov-bot-size', height });
        };

        const onLoad = () => send(true);
        const onResize = () => send(false);
        const onMessage = (e) => {
            if (!e || e.source !== win.parent || !targets.includes(e.origin)) return;
            const d = e.data;
            if (!d || typeof d !== 'object' || d.type !== 'ov-bot-theme') return;
            if (robot && typeof d.robot_id === 'string' && d.robot_id !== robot) return;
            const tokens = sanitizeTokens(d.tokens);
            for (const [name, value] of Object.entries(tokens)) html.style.setProperty(name, value);
            const scheme = validScheme(d.tokens && d.tokens['--color-scheme']);
            if (scheme) {
                html.style.setProperty('--color-scheme', scheme);
                html.setAttribute('data-theme-mode', scheme);
            }
            if (Object.keys(tokens).length || scheme) send(false);
        };

        win.addEventListener('message', onMessage);
        win.addEventListener('load', onLoad);
        win.addEventListener('resize', onResize);
        let observer = null;
        if (typeof win.ResizeObserver === 'function') {
            observer = new win.ResizeObserver(onResize);
            if (doc.body) observer.observe(doc.body);
            observer.observe(html);
        }
        send(true);

        return () => {
            win.removeEventListener('message', onMessage);
            win.removeEventListener('load', onLoad);
            win.removeEventListener('resize', onResize);
            if (timer) { win.clearTimeout(timer); timer = 0; }
            if (observer) observer.disconnect();
        };
    }

    return { TOKENS, validColor, validScheme, sanitizeTokens, validOrigin, start };
});
