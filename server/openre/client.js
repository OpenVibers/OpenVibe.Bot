'use strict';

/**
 * OpenRe.Stream client: the robot's video stream and its WHIP ingest key (T15 R5).
 *
 * OpenRe's WHIP worker admits only keys in its own store (resolveIngestKey), so a device's publish key is
 * always an OpenRe ingest key: Bot creates one stream per robot (external ref bot:robot:<id>) and hands the
 * device the key OpenRe returns, shown once and never stored here. Calls act for the robot's owner
 * (X-OV-Subject), so OpenRe limits them to that owner's streams.
 *
 * By default Bot mints its own Network service token (audience openvibe.openre) from its OAuth client
 * credentials, with openre.stream.read (find), openre.stream.write (create, archive, streaming toggles),
 * openre.key.rotate (rotate) and openre.session.read/openre.output.read/openre.output.write (the panel's
 * live video, session status and outputs). An operator-minted BOT_OPENRE_TOKEN overrides it. The
 * token is cached until 60 s before expiry; a 401 from OpenRe (rotated key, clock) drops the cached token and
 * the call is tried once more.
 *
 *   find(ref, owner)                      GET /api/v1/streams?external_ref=… → the stream, or null
 *   get(id, owner)                        GET /api/v1/streams/:id → the stream, or null on 404
 *   create(body, owner)                   POST /api/v1/streams → { stream, key: { id, key, hint } }
 *   update(id, fields, owner)             PATCH /api/v1/streams/:id → the updated stream, or null on 404
 *   rotate(id, owner, { grace_seconds, end_sessions })
 *                                         POST /api/v1/streams/:id/keys/rotate → { key: { id, key, hint }, … }
 *   archive(id, owner)                    DELETE /api/v1/streams/:id (OpenRe refuses a live stream: 409)
 *   sessions(streamId, owner, { state })  GET /api/v1/sessions?stream_id=…&state=… → the stream's sessions
 *   playback(id, owner)                   GET /api/v1/sessions/:id/playback → the descriptor, or null on 404
 *
 * A refusal (4xx) throws 502 bot.openre_refused with OpenRe's problem code and detail; no answer, a timeout
 * or a 5xx throws 503 bot.openre_unavailable. A 404 for a named stream (get, update, rotate, archive) answers null. The token is
 * never logged, returned or put in an error. Unset BOT_OPENRE_URL, or neither an operator BOT_OPENRE_TOKEN
 * nor the Network client credentials: createOpenRe → null.
 */
const { serviceAuth } = require('openvibe-contracts');
const { BotError } = require('../util');

// Network's grant to the `bot` client on audience openvibe.openre (Network server/identity/principals.js
// DEFAULT_GRANTS). session.read/output.read/output.write are for later panel video and restreaming.
const OPENRE_AUDIENCE = 'openvibe.openre';
const OPENRE_SCOPE = 'openre.stream.read openre.stream.write openre.key.rotate openre.session.read openre.output.read openre.output.write';

function createOpenRe(config, { fetchImpl = globalThis.fetch } = {}) {
    const { url, token, timeoutMs } = config.openre || {};
    if (!url) return null;
    // An operator-minted BOT_OPENRE_TOKEN wins; otherwise Bot mints its own from its Network client.
    const { clientId, clientSecret } = config.oauth || {};
    const internalUrl = (config.network || {}).internalUrl;
    const tokens = !token && clientSecret && internalUrl
        ? serviceAuth.createTokenClient({
            tokenUrl: `${internalUrl}/oauth/token`, clientId, clientSecret, audience: OPENRE_AUDIENCE, scope: OPENRE_SCOPE, fetchImpl,
        })
        : null;
    if (!token && !tokens) return null;

    /** The Authorization header of this call: the operator's token, or a freshly cached minted one. */
    async function authorization() {
        if (!tokens) return `Bearer ${token}`;
        try {
            return (await tokens.authHeaders()).Authorization;
        } catch (e) {
            throw new BotError(503, 'bot.openre_unavailable', 'Bot could not mint its OpenRe token from Network');
        }
    }

    /** One attempt; a transport failure or a timeout becomes bot.openre_unavailable. */
    async function send(method, path, { owner, body }) {
        const bearer = await authorization();
        try {
            return await fetchImpl(`${url}${path}`, {
                method,
                headers: {
                    Authorization: bearer, Accept: 'application/json', 'X-OV-Subject': owner,
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e) {
            const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `no answer within ${timeoutMs} ms` : 'unreachable';
            throw new BotError(503, 'bot.openre_unavailable', `OpenRe did not answer for the robot's video: ${why}`);
        }
    }

    async function call(method, path, opts = {}) {
        const { named = false } = opts;
        let res = await send(method, path, opts);
        // A minted token OpenRe no longer accepts (rotated signing key, clock): drop it and try once more.
        if (res.status === 401 && tokens) {
            tokens.invalidate();
            res = await send(method, path, opts);
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
        /** The stream's sessions, `state` 'open' (the default: starting, live or ending) or a named one. */
        async sessions(streamId, owner, { state = 'open' } = {}) {
            const query = `stream_id=${encodeURIComponent(streamId)}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
            const out = await call('GET', `/api/v1/sessions?${query}`, { owner });
            return (out && Array.isArray(out.sessions) && out.sessions) || [];
        },
        async playback(id, owner) {
            const out = await call('GET', `/api/v1/sessions/${encodeURIComponent(id)}/playback`, { owner, named: true });
            return (out && out.playback) || null;
        },
    };
}

module.exports = { createOpenRe };
