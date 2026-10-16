'use strict';
/**
 * Bot's model pages in OpenVibe.Search: every robot model Bot drives (/models/<id>: Cozmo, LOOI, the Adeept kits, a
 * phone camera, ONVIF cameras, ROS 2 bases…) is one document (search.index-document@1, owner bot, type model, id = the
 * profile id), written through Search's owner API with Bot's service token (search.document.write on
 * openvibe.search). A model that leaves the catalogue is tombstoned.
 *
 * Runs a minute after boot and every six hours (the catalogue changes with a deploy or an approved community driver).
 * The stored copy is read back for each model and re-sent, one revision up, only when its content differs.
 *
 * Off unless BOT_SEARCH_URL and the OAuth client secret are set.
 */
const { serviceAuth } = require('openvibe-contracts');
const { listProfiles } = require('./profiles');
const { modelOf, CONNECT, CAPABILITY_WORDS } = require('./web/directory');

const OWNER = 'bot';
const TYPE = 'model';
const EVERY_MS = 6 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;
const COMPARED = ['canonical_url', 'title', 'summary', 'body'];

/** A model (directory.modelOf) → the document body; identity and revision are added by the caller. */
function documentFor(m, { baseUrl }) {
    const how = CONNECT[m.connect] || null;
    const caps = (m.capabilities || []).map((c) => CAPABILITY_WORDS[c]).filter(Boolean);
    return {
        visibility: 'public',
        canonical_url: `${baseUrl}/models/${m.id}`,
        title: `${m.name}${m.vendor ? ` (${m.vendor})` : ''}`.slice(0, 500),
        summary: (m.description || `Drive a ${m.name} from your browser with OpenVibe.Bot.`).slice(0, 4000),
        body: [m.name, m.vendor, m.description, how ? `${how.label}: ${how.text}` : '', caps.length ? `What it does: ${caps.join(', ')}.` : '',
            ...(m.setup || []).map((step) => (typeof step === 'string' ? step : step && (step.text || step.title) ? String(step.text || step.title) : ''))]
            .filter(Boolean).join('\n').slice(0, 48000),
        facets: { kind: 'robot_model', connect: m.connect, ...(m.vendor ? { vendor: m.vendor } : {}), community: Boolean(m.community) },
        authorship: 'human',
        publication_state: 'published',
        indexability: { decision: 'index', reasons: [] },
    };
}

function createModelSearchIndex({ config, db, fetchImpl = globalThis.fetch, log = console, tokens = null, models = null }) {
    const url = String((config.search && config.search.url) || '').replace(/\/+$/, '');
    const enabled = Boolean(url && (tokens || config.oauth.clientSecret));
    const auth = tokens || (enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.search', scope: 'search.document.write', fetchImpl,
    }) : null);
    const baseUrl = String(config.baseUrl).replace(/\/+$/, '');
    const list = models || (async () => (await listProfiles(db)).map((row) => modelOf(row.profile)));
    const stats = { runs: 0, upserted: 0, deleted: 0, unchanged: 0, failed: 0, last_error: null };

    async function call(method, p, body) {
        const res = await fetchImpl(`${url}${p}`, {
            method,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await auth.authHeaders()) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 401 && auth.invalidate) auth.invalidate();
        return { status: res.status, ok: res.ok, body: json };
    }

    async function run() {
        if (!enabled) return null;
        stats.runs++;
        const listing = await call('GET', `/api/v1/owners/${OWNER}/documents?type=${TYPE}&limit=1000`);
        if (!listing.ok) throw new Error(`listing: ${listing.status} ${listing.body.code || ''}`);
        const remote = new Map((listing.body.documents || []).map((d) => [d.id, d]));
        const keep = new Set();
        for (const m of await list()) {
            if (!ID_RE.test(String(m.id))) continue;
            keep.add(m.id);
            const doc = documentFor(m, { baseUrl });
            const r = remote.get(m.id);
            if (r && !r.deleted) {
                const stored = await call('GET', `/api/v1/owners/${OWNER}/documents/${TYPE}/${encodeURIComponent(m.id)}`);
                const s = stored.ok ? stored.body.document : null;
                if (s && COMPARED.every((k) => s[k] === doc[k])) { stats.unchanged++; continue; }
            }
            const res = await call('PUT', `/api/v1/documents/${OWNER}/${TYPE}/${encodeURIComponent(m.id)}`, { ...doc, revision: r ? Number(r.revision) + 1 : 1 });
            if (res.ok) stats.upserted++;
            else { stats.failed++; stats.last_error = `${m.id}: ${res.status} ${res.body.code || ''}`; }
        }
        for (const [id, r] of remote) {
            if (keep.has(id) || r.deleted) continue;
            const res = await call('DELETE', `/api/v1/documents/${OWNER}/${TYPE}/${encodeURIComponent(id)}?revision=${Number(r.revision) + 1}`);
            if (res.ok) stats.deleted++;
            else { stats.failed++; stats.last_error = `${id}: ${res.status} ${res.body.code || ''}`; }
        }
        return { ...stats };
    }

    const quietly = () => run().catch((err) => { stats.failed++; stats.last_error = err.message; log.warn(`[Bot] search index run failed: ${err.message}`); });
    let timer = null;
    let first = null;
    return {
        enabled,
        run,
        stats: () => ({ ...stats }),
        start({ firstDelayMs = 60_000 } = {}) {
            if (!enabled || timer) return;
            first = setTimeout(quietly, firstDelayMs);
            if (first.unref) first.unref();
            timer = setInterval(quietly, EVERY_MS);
            if (timer.unref) timer.unref();
        },
        stop() { clearTimeout(first); clearInterval(timer); timer = null; first = null; },
    };
}

module.exports = { createModelSearchIndex, documentFor };
