'use strict';

/**
 * The person's ui.layout@1 from OpenVibe.Network, for one surface and one device class.
 *
 * The panel reads the active layout server-side before it renders, so a signed-in person never sees the default
 * flash and then their own arrangement. The browser's first-party session cookie is an OpenVibe.Network access
 * token, so the read is the person's own `GET /api/v1/me/layouts/:surface?device=` (the panel is not given any
 * extra account power). A Network that is slow or down leaves the default: the panel still opens and commands
 * still reach the robot. Saving and asking OpenVibe go through Bot's own thin proxies (routes.js), which carry
 * the same cookie, so neither ever reaches the page's script.
 */
const TIMEOUT_MS = 1200;
const WRITE_TIMEOUT_MS = 15000;
const SUGGEST_TIMEOUT_MS = 30000;

function base(config) {
    return String(config.network.url || '').replace(/\/+$/, '');
}

async function call(config, token, method, path, body, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS) {
    const res = await fetchImpl(`${base(config)}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const out = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, out };
}

/** The active layout, or null when the person has not made one (404) or Network cannot answer. */
async function activeLayout({ config, token, surface, device, fetchImpl }) {
    if (!token || !surface || !device) return null;
    try {
        const r = await call(config, token, 'GET', `/api/v1/me/layouts/${encodeURIComponent(surface)}?device=${encodeURIComponent(device)}`, null, fetchImpl);
        if (r.status === 404) return null;
        if (!r.ok) return null;
        const layout = r.out && (r.out.layout || (Array.isArray(r.out.parts) ? r.out : null));
        return layout && typeof layout === 'object' ? layout : null;
    } catch { return null; }
}

/** PUT the active layout. Returns Network's answer ({ layout } or the layout) or throws with a plain reason. */
async function saveLayout({ config, token, surface, device, layout, catalog, fetchImpl }) {
    if (!catalog) throw new Error('the surface catalog is needed to save an arrangement');
    const r = await call(config, token, 'PUT', `/api/v1/me/layouts/${encodeURIComponent(surface)}?device=${encodeURIComponent(device)}`, { catalog, layout }, fetchImpl, WRITE_TIMEOUT_MS);
    if (!r.ok) throw new Error((r.out && (r.out.detail || r.out.error)) || `Network answered ${r.status}`);
    return r.out;
}

/** POST the person's words; Network checks entitlement and forwards to OpenVibe.AI's ui.layout.suggest. */
async function suggestLayout({ config, token, surface, device, words, layout, catalog, fetchImpl }) {
    const body = { words, layout, catalog, device };
    const r = await call(config, token, 'POST', `/api/v1/me/layouts/${encodeURIComponent(surface)}/suggest?device=${encodeURIComponent(device)}`, body, fetchImpl, SUGGEST_TIMEOUT_MS);
    if (!r.ok) throw new Error((r.out && (r.out.detail || r.out.error)) || `Network answered ${r.status}`);
    return r.out;
}

/** Save, then make a share link for that layout (Network's own public read route, made absolute). */
async function shareLayout({ config, token, surface, device, layout, catalog, fetchImpl }) {
    const saved = await saveLayout({ config, token, surface, device, layout, catalog, fetchImpl });
    if (!saved || !saved.id) throw new Error('Network did not return the saved layout');
    const r = await call(config, token, 'POST', `/api/v1/me/layouts/${encodeURIComponent(saved.id)}/share`, {}, fetchImpl, WRITE_TIMEOUT_MS);
    if (!r.ok) throw new Error((r.out && (r.out.detail || r.out.error)) || `Network answered ${r.status}`);
    const url = r.out && r.out.url;
    if (url) { try { r.out.url = new URL(url, base(config) + '/').toString(); } catch { /* relative is still a link */ } }
    return r.out;
}

module.exports = { activeLayout, saveLayout, suggestLayout, shareLayout, TIMEOUT_MS };
