'use strict';

/**
 * The embeddable panel's frame adapter (plan T15: "the robot control is not perfected … fit any page it is placed in").
 *
 * The page around the frame (OpenVibe.Live's public/js/bot-embed.js) owns the look and the height:
 *
 *   ov-bot-theme  { tokens: { '--bg-primary', '--bg-card', '--text-primary', '--text-secondary', '--accent',
 *                             '--accent-strong', '--on-accent-strong', '--border', '--color-scheme' } }
 *                 → set each valid plain colour on <html>; --color-scheme must be 'dark' or 'light'.
 *   ov-bot-size   { height, mode, minWidth, minHeight, hit? } ← the embed's own content height, its view, the size
 *                 it needs, and for an overlay the rectangles the controls occupy (so the page can let presses
 *                 through everywhere else), sent on load and when it changes, at most five times a second (a
 *                 trailing edge, so the last size always goes).
 *   ov-bot-mode   { mode: 'panel' | 'overlay' | 'compact' } → the frame reloads itself in that view, so a host can
 *                 offer the same switch the query (?mode=) does without rebuilding the frame itself.
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
    const MODES = ['panel', 'overlay', 'compact'];
    // The smallest frame each view stays usable in; the server also writes these to <html> (data-bot-min-*).
    const MIN_SIZE = { panel: { minWidth: 320, minHeight: 480 }, overlay: { minWidth: 280, minHeight: 196 }, compact: { minWidth: 320, minHeight: 112 } };

    function validColor(value) {
        return typeof value === 'string' && value.length <= MAX_LEN && COLOR_RE.test(value.trim());
    }

    /** 'dark' | 'light' | null. */
    function validScheme(value) {
        return value === 'dark' || value === 'light' ? value : null;
    }

    /** 'panel' | 'overlay' | 'compact', or null. */
    function validMode(value) {
        return MODES.includes(value) ? value : null;
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
        let lastMode = null;
        let lastHit = '';

        const measure = () => {
            const body = doc.body;
            if (!body) return 0;
            let height = 0;
            try {
                height = Math.max(height, body.scrollHeight || 0, Math.ceil(body.getBoundingClientRect().height));
            } catch { /* a document going away */ }
            return Math.max(0, Math.ceil(height));
        };
        const attr = (name) => {
            try { return html.getAttribute ? html.getAttribute(name) : null; } catch { return null; }
        };
        const view = () => validMode(attr('data-bot-view')) || 'panel';
        const sizes = (mode) => {
            const fallback = MIN_SIZE[mode] || MIN_SIZE.panel;
            const w = Number(attr('data-bot-min-width'));
            const h = Number(attr('data-bot-min-height'));
            return { minWidth: Number.isFinite(w) && w > 0 ? w : fallback.minWidth, minHeight: Number.isFinite(h) && h > 0 ? h : fallback.minHeight };
        };
        // The controls' own boxes, so a page can clip the transparent frame to them and let every other press
        // reach the picture underneath. Only the overlay has anything worth reporting.
        const hitAreas = (mode) => {
            if (mode !== 'overlay' || !doc.querySelectorAll) return [];
            const out = [];
            for (const el of doc.querySelectorAll('[data-bot-hit]')) {
                let r;
                try { r = el.getBoundingClientRect(); } catch { continue; }
                if (!r || !(r.width > 0) || !(r.height > 0)) continue;
                out.push({ x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), w: Math.ceil(r.width), h: Math.ceil(r.height) });
                if (out.length >= 12) break;
            }
            return out;
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
            const mode = view();
            const { minWidth, minHeight } = sizes(mode);
            const hit = hitAreas(mode);
            const hitKey = JSON.stringify(hit);
            if (!force && height === lastHeight && mode === lastMode && hitKey === lastHit) return;
            stopAt = now;
            lastHeight = height;
            lastMode = mode;
            lastHit = hitKey;
            const message = { ...(robot ? { robot_id: robot } : {}), type: 'ov-bot-size', height, mode, minWidth, minHeight, ...(hit.length ? { hit } : {}) };
            post(message);
        };

        const onLoad = () => send(true);
        const onResize = () => send(false);
        const onMessage = (e) => {
            if (!e || e.source !== win.parent || !targets.includes(e.origin)) return;
            const d = e.data;
            if (!d || typeof d !== 'object') return;
            if (robot && typeof d.robot_id === 'string' && d.robot_id !== robot) return;
            if (d.type === 'ov-bot-mode') {
                const mode = validMode(d.mode);
                if (!mode || mode === view()) return;
                // A view is server-rendered (its controls come from the profile), so the frame reloads itself in it:
                // the page around it does not have to rebuild the iframe to switch modes.
                try {
                    const loc = win.location;
                    if (!loc || typeof loc.href !== 'string') return;
                    const u = new win.URL(loc.href);
                    u.searchParams.set('mode', mode);
                    loc.replace(u.href);
                } catch { /* no location (a test's fake window) */ }
                return;
            }
            if (d.type !== 'ov-bot-theme') return;
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
        // Over a picture the body never changes size, but its controls do: Drive gives way to the e-stop, a line
        // appears under them. Their boxes are the page's clip, so a control shown or hidden is sent again.
        let watcher = null;
        if (view() === 'overlay' && typeof win.MutationObserver === 'function' && doc.body) {
            watcher = new win.MutationObserver(onResize);
            watcher.observe(doc.body, { attributes: true, subtree: true, childList: true, characterData: true, attributeFilter: ['hidden'] });
        }
        send(true);

        return () => {
            win.removeEventListener('message', onMessage);
            win.removeEventListener('load', onLoad);
            win.removeEventListener('resize', onResize);
            if (timer) { win.clearTimeout(timer); timer = 0; }
            if (observer) observer.disconnect();
            if (watcher) watcher.disconnect();
        };
    }

    return { TOKENS, MODES, MIN_SIZE, validColor, validScheme, validMode, sanitizeTokens, validOrigin, start };
});
