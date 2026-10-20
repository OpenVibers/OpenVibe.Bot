'use strict';

/**
 * OpenVibe.Bot — devices, pairing and control for robots (ADR-043). Express app factory; server/index.js
 * listens, tests build their own instance.
 *
 *   GET  /api/health, /api/ready, /release.json, /metrics (direct loopback callers only)
 *   /api/v1/*    the API (service tokens + user tokens, see api/v1.js)
 *   /auth/*      Network SSO session for people (the control WS accepts the ov_token cookie)
 *   GET  /       the front page (web/home.js); /sitemap.xml, /robots.txt, /llms.txt, /llms-full.txt and
 *                /manifest.webmanifest (web/routes.js)
 *   GET  /terms, /privacy, /dmca   the legal pages (openvibe-shared/legal)
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
const { createKeyProvider, createUserAuth, createNodePrincipals, createIdentity, createOfferReporter } = require('./network');
const { createOfferPublisher } = require('./jobs/offers');
const { createOpenRe } = require('./openre/client');
const { createBotOutbox } = require('./events/outbox');
const { createUsageRelay } = require('./jobs/metering');
const { createDomain } = require('./domain');
const accountDataLib = require('./account-data');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { createRealtime } = require('./realtime');
const { createSimulator } = require('./sim');
const { createOnvif } = require('./onvif');
const { createApiAuth } = require('./api/auth');
const { v1Router } = require('./api/v1');
const { createClaims } = require('./claims');
const { createJobs } = require('./jobs');
const { createActorLimits } = require('./api/actor-limits');
const { createSessionRoutes, viewerMiddleware } = require('./web/session');
const { createWebRoutes } = require('./web/routes');
const { HOME_CSP } = require('./web/home');
const { createSubmissions } = require('./submissions');
const { createRoutines } = require('./routines');
const { createWebhooks } = require('./webhooks');
const { createWebhookPoster } = require('./net/webhook-post');
const { inputError } = require('./util');
const { createBotReadiness, registerBotGauges } = require('./observability');

const VERSION = require('../package.json').version;

/**
 * The browser-facing 404 (the API's is problem+json): a plain, JavaScript-free page with a way back.
 * The app's CSP applies, so it carries no inline styles or scripts.
 */
const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Not found — OpenVibe.Bot</title></head>
<body><main><h1>Not found</h1><p>There is nothing at this address. Go to the <a href="/">OpenVibe.Bot home page</a>.</p></main></body>
</html>
`;

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
    const identity = opts.identity || createIdentity(config, { fetchImpl });
    const openre = opts.openre !== undefined ? opts.openre : createOpenRe(config, { fetchImpl });
    // Webhooks are made first: the domain writes their deliveries in the transaction that emits each event.
    const webhooks = createWebhooks({ db, post: createWebhookPoster({ userAgent: 'OpenVibe.Bot' }), now, log, tickMs: config.automation.webhookTickMs });
    let routines = null;
    const domain = createDomain({ db, config, outbox, link: hub, nodes, openre, now, log, webhooks,
        onEvent: (type, robotId) => { if (type === 'bot.robot.online' && routines) routines.onOnline(robotId).catch((e) => log.warn(`[Bot] online routines: ${e.message}`)); } });
    routines = createRoutines({ db, domain, hub, now, log, tickMs: config.automation.routineTickMs });
    const submissions = createSubmissions({ db, config, now, log });
    // Devices that ask to be added (the installer with no code, /link): the approval makes the robot; once its device
    // has paired, what the owner asked for is turned on (server/claims.js).
    const claims = createClaims({ db, domain, config, now, log });
    domain.pairing.onPaired((robotId) => claims.afterPair(robotId));
    hub.bindDomain(domain);
    // One jobs service for the device socket and the jobs API, so both see the same stdout rings.
    const jobs = createJobs({ db: () => domain.db, hub, usage, log, now });
    hub.bindJobs(jobs);
    // The worker offers of the machines connected here, reported to Network for Run's placement (server/jobs/offers.js);
    // started by server/index.js with the other jobs. Without Network credentials nothing is reported.
    const offerReporter = opts.offerReporter !== undefined ? opts.offerReporter
        : (config.oauth.clientSecret ? createOfferReporter(config, { fetchImpl }) : null);
    const offers = createOfferPublisher({ db, hub, reporter: offerReporter, log, now });
    domain.devices.onChange(() => offers.poke());
    const sim = opts.sim || createSimulator({ config, domain, hub, now, log });
    // Server-side ONVIF cameras (server/onvif): the same in-process attach as the simulator, but with a real
    // kind 'server' device row and an outbound ONVIF request per ptz command.
    const onvif = opts.onvif || createOnvif({ config, domain, hub, now, log, fetchImpl, env: opts.env });
    const apiAuth = createApiAuth({ config, keys, userAuth });
    const release = require('openvibe-shared/release').createRelease({ service: 'bot', root: path.join(__dirname, '..') });

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);

    const registry = opts.registry || require('openvibe-shared/metrics').createRegistry();
    const gauges = registerBotGauges(registry, { db, hub, now, log });
    app.get('/metrics', (req, res, next) => (isLoopbackDirect(req) ? gauges.refresh().then(() => next(), () => next()) : next()));
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'bot', release: release.release, registry });
    app.use(require('openvibe-sdk/service').telemetryMiddleware);   // request telemetry: a no-op until server/index.js calls telemetry.init()

    app.use(http.middleware());
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        // Cloudflare's edge adds its Web Analytics beacon to HTML pages: its script and its report are the only outside sources.
        res.setHeader('Content-Security-Policy', ["default-src 'self'", "script-src 'self' https://static.cloudflareinsights.com", "connect-src 'self' https://cloudflareinsights.com",
            "frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'"].join('; '));
        next();
    });
    app.use(cookieParser());

    // ── OpenVibe.Events → Bot (loopback only: nginx answers 404 for /internal/) ──
    // network.account.export_requested and network.account.deleted (ADR-033), answered by openvibe-sdk/account-data's
    // consumer over account-data.js. It reads the raw body itself (the v2 signature covers it) and refuses a request that
    // came through a proxy. The sender posts to Network's internal routes with Bot's own token.
    const accountData = accountDataLib.create({ domain, log });
    const accountSend = opts.accountSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.network.internalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : async () => { throw new Error('OV_OAUTH_CLIENT_SECRET is not set: Bot cannot answer account events'); });
    // network.node.revoked (a person's paired machine revoked on Network): its devices are revoked and a live session is
    // closed at once, instead of at the machine's next reauth deadline.
    const onEvent = async (ev) => {
        if (ev && ev.event_type === 'network.node.revoked') {
            const principal = String((ev.payload && ev.payload.principal_id) || '');
            if (!/^nod_[0-9A-HJKMNP-TV-Z]{26}$/.test(principal)) return 'applied';
            const revoked = await domain.devices.revokeByNode(principal);
            for (const d of revoked) hub.closeDevice(d.id, 'machine revoked on OpenVibe.Network');
            if (revoked.length) log.log(`[Bot] node ${principal} revoked on Network: ${revoked.length} device(s) revoked`);
        }
        return 'applied';
    };
    app.post('/internal/events', accountData.consumer({ secrets: config.events.secrets, send: accountSend, onEvent, log }));

    // The OpenVibe Frame's scripts and the showcase stylesheet the front page links (content-hashed URLs).
    app.use('/shared', require('openvibe-shared/serve').handler());

    app.get('/api/health', (req, res, next) => outbox.status().then((events) => res.json({
        ok: true, service: 'bot', version: VERSION, devices_online: hub.onlineCount(), events,
    }), next));
    const readiness = createBotReadiness({ db, valkey, keys, config, outbox, hub, release: release.release, fetchImpl });
    app.get('/api/ready', readiness.handler);
    release.mount(app, { registry: metrics.registry });

    const limits = createActorLimits({ config, valkey, now: opts.limitsNow || now, registry: metrics.registry, log });
    // A computer command may carry a file to write (≤ 256 KB, base64): its route alone takes a larger body.
    app.use(/^\/api\/v1\/machines\/[^/]+\/commands$/, express.json({ limit: '400kb' }));
    app.use('/api/v1', express.json({ limit: '64kb' }), (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, apiAuth.middleware, v1Router({ domain, apiAuth, limits, hub, jobs, config, submissions, routines, webhooks, claims }));
    app.use('/auth', createSessionRoutes(config, userAuth, { fetchImpl }));
    // ── The legal pages: Terms, Privacy and DMCA on openvibe.bot itself (openvibe-shared/legal). ──
    // The document carries its own inline theme and OpenVibe Frame boot, which the strict site-wide CSP
    // refuses, so these three public pages get the front page's allowances (HOME_CSP). The `profile` is the
    // legal profile from openvibe-contracts manifests/services/bot.json (site.legalProfile).
    { const legal = require('openvibe-shared/legal');
      app.get(legal.PATHS, (req, res, next) => { res.setHeader('Content-Security-Policy', HOME_CSP); next(); }, legal.handler({ id: 'bot', service: 'bot', host: 'openvibe.bot', name: 'OpenVibe.Bot', profile: 'games' })); }
    app.use(viewerMiddleware(userAuth));
    app.use(createWebRoutes(config, { domain, sim, onvif, limits, identity, hub, log, submissions, routines, webhooks, claims, releaseLastmod: release.full().released_at === release.full().booted_at ? undefined : release.full().released_at }));

    app.use((req, res) => {
        if (req.path.startsWith('/api/') || req.path.startsWith('/internal/')) return http.sendProblem(res, 404, 'not_found', { ctx: req.ov });
        return res.status(404).type('html').send(NOT_FOUND_HTML);
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

    Object.assign(app.locals, { config, db, valkey, domain, keys, outbox, usage, hub, jobs, offers, sim, onvif, userAuth, metrics, submissions, routines, webhooks, claims });
    return app;
}

module.exports = { createApp, VERSION };
