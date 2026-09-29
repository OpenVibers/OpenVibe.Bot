'use strict';

/**
 * OpenVibe.Bot configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/bot.env in production). loadConfig(env) is pure so tests build their own.
 *
 * Bot is its own service on PostgreSQL (ADR-043 decision 10). It owns robots, devices, pairing and
 * control; it never moves money and never owns media (a device's camera publishes to OpenRe with a
 * per-device publish key over WHIP).
 */
require('dotenv').config();

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d = false) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const trim = (u) => String(u || '').replace(/\/+$/, '');
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4630);
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.bot' : `http://localhost:${port}`));
    return {
        nodeEnv,
        isProduction,
        port,
        host: env.HOST || '127.0.0.1',
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 1,

        // PostgreSQL (ADR-035): DATABASE_URL is the pooled runtime role through PgBouncer (transaction
        // mode), DATABASE_DIRECT_URL the owner role on a direct connection, for migrations at boot.
        db: {
            url: env.DATABASE_URL || '',
            directUrl: env.DATABASE_DIRECT_URL || '',
        },
        // Valkey: shared, never authoritative (per-actor limit counters). Unset: this process only.
        valkey: {
            url: env.VALKEY_URL || '',
            prefix: env.VALKEY_PREFIX || 'ov:bot:',
        },
        // Identity: service tokens and user tokens are RS256 JWTs signed by OpenVibe.Network.
        network: {
            url: networkUrl,
            internalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
            issuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
            publicKey: env.OV_NETWORK_PUBLIC_KEY ? env.OV_NETWORK_PUBLIC_KEY.replace(/\\n/g, '\n') : null,
        },
        audience: env.BOT_AUDIENCE || 'openvibe.bot',
        // Bot's client in the Network (client `bot`): service tokens (Events) and the OAuth code flow
        // for browser sign-in on openvibe.bot.
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'bot',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: env.OV_OAUTH_SCOPE || 'profile',
        },
        cookies: { secure: env.COOKIE_SECURE != null ? bool(env.COOKIE_SECURE) : isProduction },

        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
        },

        // Pairing (ADR-043 decision 2): an 8-character Crockford base32 code, XXXX-XXXX, 10 minutes,
        // single use, 5 wrong tries end it. Only the hash is stored.
        pairing: {
            ttlMs: int(env.BOT_PAIRING_TTL_MS, 10 * 60 * 1000),
            maxTries: int(env.BOT_PAIRING_MAX_TRIES, 5),
        },
        // Device link (ADR-043 decision 6): heartbeat 1 s, offline after 2 missed + 3 s grace; the old
        // credential stays valid 60 s after a rotation.
        device: {
            heartbeatMs: int(env.BOT_HEARTBEAT_MS, 1000),
            offlineMisses: int(env.BOT_OFFLINE_MISSES, 2),
            offlineGraceMs: int(env.BOT_OFFLINE_GRACE_MS, 3000),
            rotateGraceMs: int(env.BOT_ROTATE_GRACE_MS, 60 * 1000),
        },
        // Control gate (ADR-043 decision 5/6/8). maxCommandMs is the absolute deadline cap; the queue is
        // the only way a stranger drives a robot.
        control: {
            maxCommandMs: int(env.BOT_MAX_COMMAND_MS, 300),
            holdResendMs: int(env.BOT_HOLD_RESEND_MS, 150),
            telemetryHz: int(env.BOT_TELEMETRY_HZ, 2),
            queueTurnMs: int(env.BOT_QUEUE_TURN_MS, 60 * 1000),
            queueTurnBudget: int(env.BOT_QUEUE_TURN_BUDGET, 50),
            cooldownMs: int(env.BOT_CONTROL_COOLDOWN_MS, 0),
        },

        // Per-actor limits on /api/v1 reads (server/api/actor-limits.js).
        actorLimits: {
            minute: Math.max(1, int(env.BOT_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.BOT_LIMITS_HOUR, 3000)),
        },

        jobs: {
            enabled: env.BOT_JOBS !== 'off',
            intervalMs: int(env.BOT_JOBS_INTERVAL_MS, 5000),
        },
        // The one-line installer the owner copies next to the pairing code (the agent job builds it).
        installer: {
            scriptUrl: trim(env.BOT_INSTALLER_URL || 'https://openvibe.bot/install'),
        },
    };
}

module.exports = { loadConfig };
