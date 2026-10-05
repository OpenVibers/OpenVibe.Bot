'use strict';

/**
 * OpenVibe.Bot — devices, pairing and control for robots (ADR-043). Express app factory; server/index.js
 * listens, tests build their own instance.
 *
 *   GET  /api/health, /api/ready, /release.json, /metrics (direct loopback callers only)
 *   /api/v1/*    the API (service tokens + user tokens, see api/v1.js)
 *   /auth/*      Network SSO session for people (the control WS accepts the ov_token cookie)
 *   GET  /       a one-line text placeholder
 *   /robots, /pair/:id, /panel/:id   the signed-in pages (web/routes.js); a `sim` robot is driven by the
 *                in-process simulator (sim/index.js), which server/index.js starts for existing ones at boot
 *
 * createApp({ config, db, valkey, registry, keys, hub, outbox, usage, nodes, openre, now, fetchImpl, log }) — everything
 * injectable. `db` is an openvibe-sdk/db handle with the schema migrated; `hub` the realtime WebSocket
 * hub (server/realtime.js), whose handleUpgrade the caller attaches to the HTTP server.
 */
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { http } = require('openvibe-contracts');
const { isLoopbackDirect } = require('openvibe-shared/metrics');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createKeyProvider, createUserAuth, createNodePrincipals } = require('./network');
const { createOpenRe } = require('./openre/client');
const { createBotOutbox } = require('./events/outbox');
const { createUsageRelay } = require('./jobs/metering');
const { createDomain } = require('./domain');
const { createRealtime } = require('./realtime');
const { createSimulator } = require('./sim');
const { createApiAuth } = require('./api/auth');
const { v1Router } = require('./api/v1');
const { createJobs } = require('./jobs');
const { createActorLimits } = require('./api/actor-limits');
const { createSessionRoutes, viewerMiddleware } = require('./web/session');
const { createWebRoutes } = require('./web/routes');
const { inputError } = require('./util');
const { createBotReadiness, registerBotGauges } = require('./observability');

const VERSION = require('../package.json').version;

function createApp(opts = {}) {
    const config = opts.config || loadConfig();
    const db = opts.db || openDb(config);
    const valkey = opts.valkey || null;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const log = opts.log || console;
    const now = opts.now || (() => Date.now());
    const keys = opts.keys || createKeyProvider(config, { fetchImpl, log });
    const userAuth = createUserAuth(config, keys);
    const outbox = opts.outbox || createBotOutbox({ db, config, fetchImpl: opts.eventsFetch, now, log });
    // Job usage readings → Billing (server/jobs/metering.js); started by server/index.js with the other jobs.
    const usage = opts.usage || createUsageRelay({ db, config, fetchImpl: opts.billingFetch || fetchImpl, now, log });
    const hub = opts.hub || createRealtime({ config, keys, userAuth, log, now });
    const nodes = opts.nodes || createNodePrincipals(config, { fetchImpl });
    const openre = opts.openre !== undefined ? opts.openre : createOpenRe(config, { fetchImpl });
    const domain = createDomain({ db, config, outbox, link: hub, nodes, openre, now, log });
    hub.bindDomain(domain);
    // One jobs service for the device socket and the jobs API, so both see the same stdout rings.
    const jobs = createJobs({ db: () => domain.db, hub, usage, log, now });
    hub.bindJobs(jobs);
    const sim = opts.sim || createSimulator({ config, domain, hub, now, log });
    const apiAuth = createApiAuth({ config, keys, userAuth });
    const release = require('openvibe-shared/release').createRelease({ service: 'bot', root: path.join(__dirname, '..') });

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);

    const registry = opts.registry || require('openvibe-shared/metrics').createRegistry();
    const gauges = registerBotGauges(registry, { db, hub, now, log });
    app.get('/metrics', (req, res, next) => (isLoopbackDirect(req) ? gauges.refresh().then(() => next(), () => next()) : next()));
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'bot', release: release.release, registry });

    app.use(http.middleware());
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Content-Security-Policy', ["default-src 'self'", "frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'"].join('; '));
        next();
    });
    app.use(cookieParser());

    app.get('/api/health', (req, res, next) => outbox.status().then((events) => res.json({
        ok: true, service: 'bot', version: VERSION, devices_online: hub.onlineCount(), events,
    }), next));
    const readiness = createBotReadiness({ db, valkey, keys, config, outbox, hub, release: release.release, fetchImpl });
    app.get('/api/ready', readiness.handler);
    release.mount(app, { registry: metrics.registry });

    const limits = createActorLimits({ config, valkey, now: opts.limitsNow || now, registry: metrics.registry, log });
    app.use('/api/v1', express.json({ limit: '64kb' }), (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, apiAuth.middleware, v1Router({ domain, apiAuth, limits, hub, jobs, config }));
    app.use('/auth', createSessionRoutes(config, userAuth, { fetchImpl }));
    app.use(viewerMiddleware(userAuth));
    app.use(createWebRoutes(config, { domain, sim, limits, log }));

    app.use((req, res) => {
        if (req.path.startsWith('/api/') || req.path.startsWith('/internal/')) return http.sendProblem(res, 404, 'not_found', { ctx: req.ov });
        return res.status(404).type('text/plain').send('Not found\n');
    });
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err && err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov });
        const refused = inputError(err);
        if (refused && !res.headersSent && req.path.startsWith('/api/')) return http.sendProblem(res, 422, refused.code, { detail: refused.detail, ctx: req.ov });
        if (err && err.status && err.code && !res.headersSent && req.path.startsWith('/api/')) return http.sendProblem(res, err.status, err.code, { detail: err.detail, ctx: req.ov });
        log.error('[Bot] unhandled error:', err);
        if (res.headersSent) return undefined;
        if (req.path.startsWith('/api/')) return http.sendProblem(res, 500, 'bot.internal', { ctx: req.ov });
        return res.status(500).type('text/plain').send('Something went wrong\n');
    });

    Object.assign(app.locals, { config, db, valkey, domain, keys, outbox, usage, hub, jobs, sim, userAuth, metrics });
    return app;
}

module.exports = { createApp, VERSION };
