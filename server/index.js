'use strict';

/**
 * OpenVibe.Bot — process entry. `node server/index.js`
 * Listens on PORT (4630) behind nginx (openvibe.bot); see deploy/.
 *
 * Boot (ADR-035): apply migrations/ with the owner role (DATABASE_DIRECT_URL, one direct connection,
 * closed afterwards), seed the shipped profiles, then serve on the pooled runtime role (DATABASE_URL)
 * with Valkey (VALKEY_URL) for what the processes share. Several processes may start together: the
 * migration run is serialised by an advisory lock.
 *
 * Background jobs (BOT_JOBS=off disables them): the events outbox relay, the 30-day audit prune, the
 * pairing-code sweep and the turn-queue sweep (expire a turn, promote the next waiting person).
 */
const { loadConfig } = require('./config');
const { openDb, migrate } = require('./db');
const { seedProfiles } = require('./profiles');
const { createApp } = require('./app');
const { createValkey } = require('openvibe-sdk/valkey');
const { gracefulStop } = require('openvibe-sdk/service');
const { createRegistry } = require('openvibe-shared/metrics');

async function main() {
    const config = loadConfig();
    const registry = createRegistry();
    const db = openDb(config, { registry });
    const m = await migrate(config, { serving: db });
    if (m.held.length) console.warn(`[Bot] migrations held: ${m.held.map((h) => `${h.id} (${h.reason})`).join('; ')}`);
    await seedProfiles(db, { log: console });
    const valkey = createValkey({ url: config.valkey.url, prefix: config.valkey.prefix });

    const app = createApp({ config, db, valkey, registry });
    const { domain, keys, outbox, hub } = app.locals;
    keys.start();

    const timers = [];
    if (config.jobs.enabled) {
        const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => console.warn('[Bot] job:', e.message)); }, ms); t.unref(); timers.push(t); };
        every(6 * 3600 * 1000, () => domain.audit.prune(30));
        every(30 * 60 * 1000, () => domain.pairing.prune());
        every(1000, async () => { for (const robotId of await domain.queue.sweep()) hub.broadcast(robotId); });
        outbox.start();
    }

    const server = app.listen(config.port, config.host, () => {
        console.log(`[Bot] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (store ${db.store}; valkey ${valkey ? 'on' : 'off: per process'})`);
        console.log(`[Bot] profiles from server/profiles; events relay ${outbox.enabled ? `→ ${config.events.url}` : 'off (outbox accumulates)'}; heartbeat ${config.device.heartbeatMs} ms, offline after ${config.device.heartbeatMs * config.device.offlineMisses + config.device.offlineGraceMs} ms`);
    });
    server.keepAliveTimeout = 65_000;
    server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));

    // systemd sends SIGTERM (SIGINT by hand); openvibe-sdk/service's gracefulStop takes the signal, runs the stop
    // steps in order (nothing new starts), drains the HTTP server, runs the close steps, then exits. The stop steps
    // keep the old hand-written shutdown's exact order, and hub.close stays a stop step BEFORE the drain: upgraded
    // WebSocket sockets are not tracked by server.close. drainMs bounds the drain; deadlineMs 5000 keeps the old 5 s
    // hard timer and deadlineExitCode 0 its exit 0. Bot's manifest declares no lifecycle.shutdown deadline, so the
    // kit's 5000 ms default is the right value.
    const { stop: shutdown } = gracefulStop({
        name: 'Bot',
        server,
        drainMs: 4000,
        deadlineMs: 5000,
        deadlineExitCode: 0,
        stop: [
            () => timers.forEach(clearInterval),
            () => keys.stop(),
            () => hub.close().catch(() => {}),
            () => outbox.stop(),
        ],
        close: [
            () => db.close().catch(() => {}),
            () => valkey && valkey.close().catch(() => {}),
        ],
    });
    return { app, server, shutdown };
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`[Bot] could not start: ${e.message}`);
        process.exit(1);
    });
}

module.exports = { main };
