'use strict';

/**
 * Truthful readiness (GET /api/ready) and the Bot gauges (GET /metrics).
 *
 *   db            required  a real round trip through the pool (db.ready(): the store that answered)
 *   valkey        optional  a real PING; without it per-actor limits are counted in each process
 *   network_jwks  optional  the Network signing key has loaded; without it no token can be verified
 *   events        optional  OpenVibe.Events answers /api/health; without it bot.* events wait in the outbox
 *
 * Gauges: robots, devices, devices online, people waiting in a turn queue, and the events outbox
 * backlog. Counts only, never subjects; a scrape whose read failed leaves them out.
 */
const { sql } = require('openvibe-sdk/db');
const { createReadiness, skip } = require('openvibe-shared/ready');
const { TABLE: OUTBOX } = require('./events/outbox');

const PING_TTL_MS = 15_000;

function probe(url, fetchImpl) {
    return async () => {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000), headers: { Accept: 'application/json' } });
        try { await res.body?.cancel(); } catch { /* not needed */ }
        return res.ok ? { ok: true, detail: { http_status: res.status } } : { ok: false, error: `answered HTTP ${res.status}`, detail: { http_status: res.status } };
    };
}

function createBotReadiness({ db, valkey = null, keys, config, outbox, hub = null, release = null, fetchImpl = globalThis.fetch }) {
    const events = outbox.enabled
        ? probe(`${config.events.url}/api/health`, fetchImpl)
        : () => 'events relay off (EVENTS_URL or OV_OAUTH_CLIENT_SECRET unset): bot.* events wait in the outbox';
    return createReadiness({
        service: 'bot',
        release,
        checks: [
            { name: 'db', required: true, check: () => db.ready() },
            { name: 'valkey', required: false, check: () => (valkey ? valkey.ready() : skip('VALKEY_URL unset: per-actor limits are per process (one process only)')) },
            { name: 'network_jwks', required: false, check: () => (keys.get() ? true : 'Network signing key not loaded yet: tokens cannot be verified') },
            { name: 'events', required: false, cacheMs: outbox.enabled ? PING_TTL_MS : 0, timeoutMs: 2500, check: events },
        ],
        details: async (body) => (body.checks.db.status === 'ok'
            ? { events_outbox: await outbox.status(), devices_online: hub ? hub.onlineCount() : 0, queue_waiting: await queueWaiting(db) }
            : { events_outbox: null, devices_online: null, queue_waiting: null }),
    });
}

async function queueWaiting(db) {
    return Number(await db.value(`SELECT count(*)::int FROM robot_queue WHERE state = 'waiting'`) || 0);
}

/** Bot gauges on the openvibe-shared/metrics registry; refresh() reads them all in one query. */
function registerBotGauges(registry, { db, hub = null, now = () => Date.now(), log = console }) {
    let snap = null;
    const read = (f) => () => (snap ? f(snap) : undefined);
    registry.gauge({ name: 'bot_robots', help: 'Robots on Bot', collect: read((s) => s.robots) });
    registry.gauge({ name: 'bot_devices', help: 'Devices that are not revoked', collect: read((s) => s.devices) });
    registry.gauge({ name: 'bot_queue_waiting', help: 'People waiting for a turn in a queue robot', collect: read((s) => s.queue) });
    registry.gauge({ name: 'bot_outbox_pending', help: 'bot.* events waiting in the outbox', collect: read((s) => s.outbox) });
    return {
        async refresh() {
            try {
                snap = await Promise.race([
                    db.one(sql`SELECT
                        (SELECT count(*) FROM robots)::int AS robots,
                        (SELECT count(*) FROM devices WHERE revoked_at IS NULL)::int AS devices,
                        (SELECT count(*) FROM robot_queue WHERE state = 'waiting')::int AS queue,
                        (SELECT count(*) FROM ${sql.ident(OUTBOX)} WHERE sent_at IS NULL AND rejected_at IS NULL)::int AS outbox`),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000).unref()),
                ]);
            } catch (e) {
                snap = null;
                log.warn(`[Bot] gauges not read: ${e.message}`);
            }
        },
    };
}

/** Truthful count of online devices, read from the live hub (not the database). */
function onlineCount(hub) { return hub ? [...hub.devices()].filter((c) => c.online).length : 0; }

module.exports = { createBotReadiness, registerBotGauges };
