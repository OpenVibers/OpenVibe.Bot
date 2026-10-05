'use strict';

/**
 * OpenRe.Stream client: the robot's video stream and its WHIP ingest key (T15 R5).
 *
 * OpenRe's WHIP worker admits only keys in its own store (resolveIngestKey), so a device's publish key is
 * always an OpenRe ingest key: Bot creates one stream per robot (external ref bot:robot:<id>) and hands the
 * device the key OpenRe returns, shown once and never stored here. Calls carry BOT_OPENRE_TOKEN, a Network
 * service token holding openre.stream.read (find), openre.stream.write (create, archive) and openre.key.rotate
 * (rotate), and act for the robot's owner
 * (X-OV-Subject), so OpenRe limits them to that owner's streams.
 *
 *   find(ref, owner)                      GET /api/v1/streams?external_ref=… → the stream, or null
 *   get(id, owner)                        GET /api/v1/streams/:id → the stream, or null on 404
 *   create(body, owner)                   POST /api/v1/streams → { stream, key: { id, key, hint } }
 *   update(id, fields, owner)             PATCH /api/v1/streams/:id → the updated stream, or null on 404
 *   rotate(id, owner, { grace_seconds, end_sessions })
 *                                         POST /api/v1/streams/:id/keys/rotate → { key: { id, key, hint }, … }
 *   archive(id, owner)                    DELETE /api/v1/streams/:id (OpenRe refuses a live stream: 409)
 *
 * A refusal (4xx) throws 502 bot.openre_refused with OpenRe's problem code and detail; no answer, a timeout
 * or a 5xx throws 503 bot.openre_unavailable. A 404 for a named stream (get, update, rotate, archive) answers null. The token is
 * never logged, returned or put in an error. Unset BOT_OPENRE_URL or BOT_OPENRE_TOKEN: createOpenRe → null.
 */
const { BotError } = require('../util');

function createOpenRe(config, { fetchImpl = globalThis.fetch } = {}) {
    const { url, token, timeoutMs } = config.openre || {};
    if (!url || !token) return null;

    async function call(method, path, { owner, body, named = false } = {}) {
        let res;
        try {
            res = await fetchImpl(`${url}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-OV-Subject': owner,
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e) {
            const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `no answer within ${timeoutMs} ms` : 'unreachable';
            throw new BotError(503, 'bot.openre_unavailable', `OpenRe did not answer for the robot's video: ${why}`);
        }
        if (res.status === 204) return {};
        const out = await res.json().catch(() => null);
        if (res.ok && out) return out;
        if (res.status === 404 && named) return null;
        const code = out && typeof out.code === 'string' ? out.code : null;
        const detail = out && typeof out.detail === 'string' ? `: ${out.detail.slice(0, 200)}` : '';
        if (res.status >= 400 && res.status < 500) {
            throw new BotError(502, 'bot.openre_refused', `OpenRe refused the robot's video (${res.status}${code ? ` ${code}` : ''})${detail}`, { openre: { status: res.status, code } });
        }
        throw new BotError(503, 'bot.openre_unavailable', `OpenRe answered ${res.status} for the robot's video`);
    }
    const stream = (id) => `/api/v1/streams/${encodeURIComponent(id)}`;
    return {
        async find(ref, owner) {
            const out = await call('GET', `/api/v1/streams?external_ref=${encodeURIComponent(ref)}`, { owner });
            return (out && Array.isArray(out.streams) && out.streams[0]) || null;
        },
        async get(id, owner) {
            const out = await call('GET', stream(id), { owner, named: true });
            return (out && out.stream) || null;
        },
        create: (body, owner) => call('POST', '/api/v1/streams', { owner, body }),
        // Only the two streaming toggles this client owns are ever sent: a PATCH naming one leaves the other
        // as it is on OpenRe.
        async update(id, fields, owner) {
            const body = {};
            if (fields && fields.recording_mode !== undefined) body.recording_mode = fields.recording_mode;
            if (fields && fields.mirror_to_live !== undefined) body.mirror_to_live = fields.mirror_to_live;
            const out = await call('PATCH', stream(id), { owner, body, named: true });
            return (out && out.stream) || null;
        },
        rotate: (id, owner, { grace_seconds = 0, end_sessions = false } = {}) =>
            call('POST', `${stream(id)}/keys/rotate`, { owner, body: { grace_seconds, end_sessions }, named: true }),
        archive: (id, owner) => call('DELETE', stream(id), { owner, named: true }),
    };
}

module.exports = { createOpenRe };
