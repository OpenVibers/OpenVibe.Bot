'use strict';

/**
 * Per-actor rate limits at /api/v1 (openvibe-sdk/limits). Counted by who calls, as api/auth.js resolved
 * req.principal. Past a limit the route answers 429 problem+json `rate_limited` with Retry-After.
 * Never limited: /api/health, /api/ready, /release.json, /metrics and the one-line GET /.
 */
const { createActorLimiter, createValkeyLimitStore, defaultActor } = require('openvibe-sdk/limits');
const { userSubject } = require('../util');

function actor(req) {
    // A route a service may call on a person's behalf (limiter.actedFor below) counts the call against that
    // person, exactly as their own token would — never against the shared service principal.
    if (req.limitSubject) return `user:${req.limitSubject}`;
    const p = req.principal;
    if (p && (p.kind === 'service' || p.kind === 'node') && p.sub) return p.sub;
    if (p && p.kind === 'user' && p.subject) return `user:${p.subject}`;
    return defaultActor(req);
}

function createActorLimits({ config, valkey = null, now = () => Date.now(), registry = null, log = console }) {
    const refused = registry
        ? registry.counter({ name: 'bot_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.actorLimits.minute, hour: config.actorLimits.hour },
        actor, now, store: createValkeyLimitStore(valkey), log,
        onLimited(e) {
            log.warn(`[Bot] limit ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? limit(req, res, next) : next());
    };
    /**
     * A route a service may call on a person's behalf (the command route: a bound channel's chat forwards a
     * viewer's command). When the caller is a service naming a subject (`X-OV-Subject` / body `owner`), the
     * call is counted against `user:<subject>` exactly as that person's own token is, so one shared service
     * token never puts every viewer in one bucket. A person's own token is keyed as before; an invalid subject
     * is left for the route to refuse.
     */
    limiter.actedFor = (name, own = {}) => {
        const limit = limiter(name, own);
        return (req, res, next) => {
            if (req.principal && req.principal.kind === 'service') {
                const s = req.headers['x-ov-subject'] || req.body?.owner;
                if (s != null && s !== '') { try { req.limitSubject = userSubject(s, 'subject'); } catch { /* the route refuses it */ } }
            }
            return limit(req, res, next);
        };
    };
    return limiter;
}

module.exports = { createActorLimits, actor };
