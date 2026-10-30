'use strict';

/**
 * A machine's coding agents, as its OpenVibe.Node reports them (Codes C9c).
 *
 * The Node reads them with OpenVibe.Codes' own logins probe (`openvibe-codes logins --json`, as the machine's user)
 * and sends the reading with every heartbeat (`bot.device-message@1`'s `fleet`): each agent's id, whether it is
 * installed and signed in, and each limit window's label, what it has used of its limit, and when it frees. Bot keeps
 * the latest reading per machine (`devices.fleet`, `devices.fleet_at`) for Codes' Agents page, its router and its MCP.
 *
 * What arrives is bounded here exactly as the Node bounds it before sending, because a frame is whatever the socket
 * says: an agent id shaped like an id, at most 16 agents, at most 10 windows each, a short label and reset time, two
 * finite numbers. A reading never carries a key, a token or an account name, and Bot adds none: it stores what it is
 * sent, and nothing else. `null` means the frame was not a reading at all (not an array) and the last one stands; an
 * empty array is a real answer — the probe ran and found no agents.
 */
const MAX_AGENTS = 16;
const MAX_WINDOWS = 10;
const LABEL_MAX = 40;
const AGENT_ID = /^[a-z0-9-]{1,40}$/;

/** A trimmed string of at most `max` characters, or null when it is not a non-empty string. */
function label(v, max = LABEL_MAX) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s && s.length <= max ? s : null;
}

function windowOf(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = label(raw.name);
    if (!name) return null;
    const w = { name };
    for (const k of ['used', 'limit']) if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) w[k] = raw[k];
    const resets = label(raw.resets_at);
    if (resets) w.resets_at = resets;
    return w;
}

function agentOf(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.agent !== 'string' || !AGENT_ID.test(raw.agent)) return null;
    const a = { agent: raw.agent, installed: raw.installed === true, signed_in: raw.signed_in === true };
    if (Array.isArray(raw.windows)) {
        const windows = raw.windows.map(windowOf).filter(Boolean).slice(0, MAX_WINDOWS);
        if (windows.length) a.windows = windows;
    }
    return a;
}

/** The bounded reading a heartbeat carried, or null when it carried none (a non-array `fleet`). */
function sanitize(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    const seen = new Set();
    for (const r of raw) {
        const a = agentOf(r);
        if (!a || seen.has(a.agent)) continue;
        seen.add(a.agent);
        out.push(a);
        if (out.length >= MAX_AGENTS) break;
    }
    return out;
}

module.exports = { sanitize, MAX_AGENTS, MAX_WINDOWS, LABEL_MAX };
