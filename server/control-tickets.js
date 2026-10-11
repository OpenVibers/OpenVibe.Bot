'use strict';
/**
 * One-time control tickets: driving a robot from its panel framed on another site (plan T15 R9, the Live channel page).
 *
 * The frame cannot see the openvibe.bot session (the cookie is SameSite=Lax, and the frame is cross-site), so it starts
 * as a read-only watcher. Its Drive button opens /panel/:id/drive in a first-party popup, which has the session, mints a
 * ticket here (POST /panel/:id/ticket) and hands it to the frame by postMessage, same origin only. The frame then opens
 * /control offering the ticket as a WebSocket subprotocol ("ov.ticket", "ov.ticket.<ticket>"), so it never appears in a
 * URL or an access log.
 *
 * A ticket is single use, lives TTL_MS and names one robot and one person. A join made with one carries the next
 * ticket, so a dropped socket reconnects without asking again; an unused one simply expires. Every permission is still
 * decided at the join, by the person's role on that robot, exactly as on openvibe.bot itself.
 */
const crypto = require('crypto');

const TTL_MS = 120_000;
const MAX_TICKETS = 10_000;
const PROTOCOL = 'ov.ticket';
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

function createControlTickets({ now = () => Date.now(), ttlMs = TTL_MS } = {}) {
    const tickets = new Map();   // ticket → { principal, robotId, exp }

    function sweep() {
        const t = now();
        for (const [k, v] of tickets) if (v.exp <= t) tickets.delete(k);
    }

    /** A new ticket for `principal` (a user principal) on `robotId`, or null when the store is full. */
    function issue(principal, robotId) {
        if (!principal || principal.kind !== 'user' || !principal.subject || !robotId) return null;
        if (tickets.size >= MAX_TICKETS) sweep();
        if (tickets.size >= MAX_TICKETS) return null;
        const ticket = crypto.randomBytes(32).toString('base64url');
        const { ticketRobot, ...who } = principal;   // a principal made from a ticket never carries it into the next
        tickets.set(ticket, { principal: who, robotId: String(robotId), exp: now() + ttlMs });
        return { ticket, expires_in: Math.round(ttlMs / 1000) };
    }

    /** The ticket's { principal, robotId }, once; null when unknown, used or expired. */
    function redeem(ticket) {
        const key = String(ticket || '');
        const t = tickets.get(key);
        if (!t) return null;
        tickets.delete(key);
        return t.exp > now() ? t : null;
    }

    return { issue, redeem, sweep, size: () => tickets.size };
}

/** The ticket a /control upgrade offers in Sec-WebSocket-Protocol ("ov.ticket, ov.ticket.<ticket>"), or null. */
function ticketFromProtocols(header) {
    const offered = String(header || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!offered.includes(PROTOCOL)) return null;
    const named = offered.find((p) => p.startsWith(`${PROTOCOL}.`));
    const value = named ? named.slice(PROTOCOL.length + 1) : '';
    return TICKET_RE.test(value) ? value : null;
}

module.exports = { createControlTickets, ticketFromProtocols, PROTOCOL, TTL_MS };
