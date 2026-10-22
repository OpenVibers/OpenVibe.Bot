'use strict';

/**
 * Public reads from the rest of the network for the front page: OpenVibe.Search's anonymous query API (public
 * documents only), so the page can link robotics openings OpenVibe.Work gathers.
 *
 *   createNetworkReads({ searchUrl, fetchImpl, log })  → { jobs() }
 *
 * jobs() never throws and never makes the page wait long: an answer is kept 15 minutes, a refresh runs in the
 * background once it is stale, and the first read waits at most READ_WAIT_MS before the page goes out without it.
 * No searchUrl (tests, a local run): every read is empty and nothing is fetched.
 */
const TTL_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 4000;
const READ_WAIT_MS = 1200;
const JOB_QUERY = 'robotics';
const JOB_LIMIT = 6;
const MAX_TITLE = 140;

const clean = (s, max = MAX_TITLE) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const httpsUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };

/** A Search document (owner work, type job) → what the page shows; anything without a title or an https link is dropped. */
function jobOf(doc) {
    const url = httpsUrl(doc && doc.canonical_url);
    const title = clean(doc && doc.title);
    if (!url || !title) return null;
    const f = (doc && doc.facets) || {};
    return { title, url, location: clean(f.location, 60), remote: f.remote === true, type: clean(String(f.type || '').split(/[,(]/)[0], 40) };
}

function createNetworkReads({ searchUrl = '', fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String(searchUrl || '').replace(/\/+$/, '');
    const cache = new Map();   // key → { at, value, pending }

    async function load(key, url, map) {
        const r = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!r.ok) throw new Error(`search answered ${r.status}`);
        const body = await r.json();
        return ((body && body.results) || []).map(map).filter(Boolean);
    }

    function read(key, url, map) {
        if (!base) return Promise.resolve([]);
        const hit = cache.get(key);
        const fresh = hit && Date.now() - hit.at < TTL_MS;
        if (hit && (fresh || hit.pending)) return Promise.resolve(hit.value);
        const pending = load(key, url, map)
            .then((value) => { cache.set(key, { at: Date.now(), value, pending: null }); return value; })
            .catch((e) => {
                log.warn(`[Bot] front page read ${key}: ${e.message}`);
                // Keep what we had; try again after a minute rather than on every request.
                cache.set(key, { at: Date.now() - TTL_MS + 60 * 1000, value: hit ? hit.value : [], pending: null });
                return hit ? hit.value : [];
            });
        cache.set(key, { at: hit ? hit.at : 0, value: hit ? hit.value : [], pending });
        if (hit) return Promise.resolve(hit.value);
        return Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve([]), READ_WAIT_MS).unref())]);
    }

    return {
        jobs: () => read('jobs', `${base}/api/v1/search?q=${encodeURIComponent(JOB_QUERY)}&owner=work&type=job&limit=${JOB_LIMIT}`, jobOf),
    };
}

module.exports = { createNetworkReads, jobOf };
