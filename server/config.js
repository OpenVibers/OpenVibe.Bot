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
const { isRobotId } = require('./util');

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d = false) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const trim = (u) => String(u || '').replace(/\/+$/, '');
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const PAIRING_AUTHORITIES = ['bot', 'network'];
// Where GET /install may send the client: OpenVibe.Node's canonical script lives on GitHub (raw, a release
// asset) or on openvibe.bot itself. Anything else refuses to boot.
const INSTALLER_SOURCE_HOSTS = ['raw.githubusercontent.com', 'github.com', 'objects.githubusercontent.com', 'openvibe.bot'];

/** BOT_INSTALLER_SOURCE_URL must be https on an allow-listed host, so /install can never become an open redirect. */
function checkInstallerSource(sourceUrl) {
    let u = null;
    try { u = new URL(sourceUrl); } catch { /* reported below */ }
    if (!u || u.protocol !== 'https:' || !INSTALLER_SOURCE_HOSTS.includes(u.hostname)) {
        throw new Error(`BOT_INSTALLER_SOURCE_URL must be an https URL on ${INSTALLER_SOURCE_HOSTS.join(', ')}, not ${JSON.stringify(sourceUrl)}`);
    }
}

const DEFAULT_EMBED_ORIGINS = ['https://openvibe.live', 'https://www.openvibe.live'];

/**
 * BOT_EMBED_ORIGINS (comma or space separated): the pages that may frame the embeddable panel. Each entry is a
 * bare https origin, no path, query or wildcard; http://localhost:<port> and http://127.0.0.1:<port> only
 * outside production. Anything else refuses to boot, so the CSP frame-ancestors list can never be widened by accident.
 */
function parseEmbedOrigins(value, isProduction) {
    const entries = String(value || '').split(/[\s,]+/).filter(Boolean);
    if (!entries.length) return [...DEFAULT_EMBED_ORIGINS];
    const out = [];
    for (const entry of entries) {
        let u = null;
        try { u = new URL(entry); } catch { /* reported below */ }
        const local = u && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname) && u.port !== '' && !isProduction;
        const bare = u && (u.protocol === 'https:' || local) && u.origin === entry && !entry.includes('*');
        if (!bare) {
            throw new Error(`BOT_EMBED_ORIGINS entries must be bare https origins like https://openvibe.live (no path, query or wildcard${isProduction ? '' : '; http://localhost:<port> is allowed outside production'}), not ${JSON.stringify(entry)}`);
        }
        if (!out.includes(entry)) out.push(entry);
    }
    return out;
}

/** The CSP frame-ancestors source list for the embeddable panel: this site and the configured origins. */
function frameAncestors(config) {
    return ["'self'", ...config.embed.origins].join(' ');
}

/**
 * BOT_ONVIF_CAMERAS: the server-side cameras the `onvif` driver connects to (server/onvif), a JSON object
 * keyed by robot id — each key names exactly one robot, so no camera is ever shared between robots. Each
 * entry is the camera's ONVIF PTZ service URL plus the *names* of the secrets holding its user and password
 * (username_ref/password_ref, an env var name or a secret store key); the values are read at request time
 * and never live in the config or the profile. The URL must be http(s), on one host, and carry no embedded
 * credentials. Anything else — including a key that is not a robot id ("*" included) — refuses to boot, so
 * the connector can only ever POST to a camera someone configured deliberately for one robot.
 */
function parseOnvifCameras(value) {
    const raw = String(value || '').trim();
    if (!raw) return {};
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`BOT_ONVIF_CAMERAS must be JSON: ${JSON.stringify(raw.slice(0, 80))}`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('BOT_ONVIF_CAMERAS must be a JSON object keyed by robot id');
    const out = {};
    for (const [key, entry] of Object.entries(parsed)) {
        if (!isRobotId(key)) throw new Error(`BOT_ONVIF_CAMERAS: ${JSON.stringify(key)} is not a robot id (rob_…): each entry names one robot, and no key is a wildcard`);
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`BOT_ONVIF_CAMERAS[${key}] must be an object`);
        let u = null;
        try { u = new URL(String(entry.url || '')); } catch { /* reported below */ }
        if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) throw new Error(`BOT_ONVIF_CAMERAS[${key}].url must be an http(s) ONVIF service URL`);
        if (u.username || u.password) throw new Error(`BOT_ONVIF_CAMERAS[${key}].url must carry no credentials: name them with username_ref/password_ref`);
        const ref = (name) => {
            const v = entry[name];
            if (v == null || v === '') return null;
            if (typeof v !== 'string' || /\s/.test(v)) throw new Error(`BOT_ONVIF_CAMERAS[${key}].${name} must be a secret reference (an env var name or a secret store key)`);
            return v;
        };
        const usernameRef = ref('username_ref');
        const passwordRef = ref('password_ref');
        if (!!usernameRef !== !!passwordRef) throw new Error(`BOT_ONVIF_CAMERAS[${key}] needs both username_ref and password_ref, or neither`);
        const profileToken = entry.profile_token == null ? 'profile_1' : String(entry.profile_token);
        if (!profileToken.trim()) throw new Error(`BOT_ONVIF_CAMERAS[${key}].profile_token must be a non-empty string`);
        out[key] = { url: u.toString(), usernameRef, passwordRef, profileToken };
    }
    return out;
}

function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4630);
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.bot' : `http://localhost:${port}`));
    const pairingAuthority = env.BOT_PAIRING_AUTHORITY == null || env.BOT_PAIRING_AUTHORITY === '' ? 'bot' : env.BOT_PAIRING_AUTHORITY;
    if (!PAIRING_AUTHORITIES.includes(pairingAuthority)) {
        throw new Error(`BOT_PAIRING_AUTHORITY must be ${PAIRING_AUTHORITIES.join(' or ')}, not ${JSON.stringify(pairingAuthority)}`);
    }
    const installerSource = String(env.BOT_INSTALLER_SOURCE_URL || 'https://github.com/OpenVibers/OpenVibe.Node/releases/latest/download/install.sh').trim();
    checkInstallerSource(installerSource);
    const embedOrigins = parseEmbedOrigins(env.BOT_EMBED_ORIGINS, isProduction);
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
        // single use, 5 wrong tries end it. Only the hash is stored. `authority` network (plan T15 B2): the
        // code is minted by Network (POST /internal/node-pairings), Bot stores none, and POST /pair and the
        // `pair` frame answer 410 bot.pairing_moved. An unknown value refuses to boot.
        pairing: {
            authority: pairingAuthority,
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
            // A Network-paired machine's node token lives 300 s; with no valid `reauth` within 330 s of the
            // last token the socket closes 4002.
            nodeReauthMs: int(env.BOT_NODE_REAUTH_MS, 330 * 1000),
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
            // The command route also caps a service by its own token (server/api/v1.js; a service may name a
            // different subject on every request, so the per-person bucket alone has no overall ceiling).
            controlServiceMinute: Math.max(1, int(env.BOT_LIMITS_CONTROL_SERVICE_MINUTE, 1200)),
            controlServiceHour: Math.max(1, int(env.BOT_LIMITS_CONTROL_SERVICE_HOUR, 12000)),
        },

        jobs: {
            enabled: env.BOT_JOBS !== 'off',
            intervalMs: int(env.BOT_JOBS_INTERVAL_MS, 5000),
        },
        // Video: a device publishes its camera to the WHIP ingest at <whipBase>/<its publish key>, returned
        // as `whip_url` by the pairing and rotation answers only. The O30 value is OpenRe.Stream's WHIP
        // ingest, https://ingest.openre.stream/whip. Unset or empty (the default) means no whip_url at all,
        // so devices pair without video until the operator names an ingest base.
        media: {
            whipBase: trim(env.BOT_WHIP_BASE || ''),
        },
        // Server-side ONVIF cameras (driver `onvif`, server/onvif): the hosts Bot may connect to, keyed by
        // robot id (one camera per robot), plus the timeout each request gets. Credentials are secret
        // references only (username_ref/password_ref), resolved when the request is built; the config never
        // holds a value.
        onvif: {
            cameras: parseOnvifCameras(env.BOT_ONVIF_CAMERAS),
            timeoutMs: Math.max(100, int(env.BOT_ONVIF_TIMEOUT_MS, 5000)),
        },
        // OpenRe.Stream (T15 R5): the publish key is the ingest key of the robot's OpenRe stream, the only kind
        // OpenRe's WHIP worker admits. token is a Network service token holding openre.stream.read (the lookup
        // by external ref), openre.stream.write and openre.key.rotate; it is never logged or returned. Either unset: devices pair without video (no
        // publish_key, `video: "not_configured"`) and Bot mints no key of its own.
        openre: {
            url: trim(env.BOT_OPENRE_URL || ''),
            token: String(env.BOT_OPENRE_TOKEN || '').trim(),
            timeoutMs: Math.max(100, int(env.BOT_OPENRE_TIMEOUT_MS, 8000)),
        },
        // OpenVibe.Billing (plan T14 L1): job usage readings go to billing.usage.record (POST <url>/api/v1/usage).
        // token is a Network service token for audience openvibe.billing holding billing.usage.record; it is never
        // logged or returned. Either unset: readings wait in run_usage_outbox (never dropped) until both are set.
        billing: {
            url: trim(env.BOT_BILLING_URL || ''),
            token: String(env.BOT_BILLING_TOKEN || '').trim(),
            intervalMs: Math.max(100, int(env.BOT_BILLING_INTERVAL_MS, 2000)),
            timeoutMs: Math.max(100, int(env.BOT_BILLING_TIMEOUT_MS, 5000)),
        },
        // The one-line installer the owner copies next to the pairing code. scriptUrl is what the command
        // prints; sourceUrl is where GET /install sends the client (302). Bot keeps no copy of the script:
        // it redirects to OpenVibe.Node's canonical one, and only this config (never a query parameter)
        // chooses the target.
        // Embeddable panel (plan T15 R9): the origins whose pages may frame a robot's read-only panel.
        embed: { origins: embedOrigins },
        // The anonymous read-only /watch socket: open sockets per client address and watchers per robot; over → close 4003.
        watch: {
            maxPerIp: Math.max(1, int(env.BOT_WATCH_MAX_PER_IP, 20)),
            maxPerRobot: Math.max(1, int(env.BOT_WATCH_MAX_PER_ROBOT, 500)),
        },
        installer: {
            scriptUrl: trim(env.BOT_INSTALLER_URL || 'https://openvibe.bot/install'),
            sourceUrl: installerSource,
            sourceHosts: INSTALLER_SOURCE_HOSTS,
        },
    };
}

module.exports = { loadConfig, frameAncestors };
