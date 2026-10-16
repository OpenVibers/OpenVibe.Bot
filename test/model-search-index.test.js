'use strict';
/**
 * Bot's model pages in OpenVibe.Search (server/search-index.js), against a stand-in Search owner API: every model of
 * the catalogue is a valid search.index-document@1 (owner bot, type model, /models/<id>); unchanged ones are not sent
 * again; a model that leaves the catalogue is tombstoned; off without BOT_SEARCH_URL.
 */
const assert = require('assert');
const http = require('http');
const { validate } = require('openvibe-contracts');
const { modelOf } = require('../server/web/directory');
const { createModelSearchIndex } = require('../server/search-index');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n      ${err && err.stack}`); }
}

function startSearch() {
    const docs = new Map();
    const puts = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const u = new URL(req.url, 'http://search.test');
            const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
            if (req.headers.authorization !== 'Bearer svc-bot') return send(401, { code: 'token.invalid' });
            if (req.method === 'GET' && u.pathname === '/api/v1/owners/bot/documents') {
                return send(200, { documents: [...docs.values()].map((d) => ({ type: 'model', id: d.id, revision: d.revision, deleted: Boolean(d.deleted) })) });
            }
            let m = /^\/api\/v1\/owners\/bot\/documents\/model\/([^/]+)$/.exec(u.pathname);
            if (m && req.method === 'GET') {
                const d = docs.get(decodeURIComponent(m[1]));
                return d && !d.deleted ? send(200, { document: d }) : send(404, { code: 'search.not_found' });
            }
            m = /^\/api\/v1\/documents\/bot\/model\/([^/]+)$/.exec(u.pathname);
            if (m && req.method === 'PUT') {
                const doc = { ...JSON.parse(raw), owner: 'bot', type: 'model', id: decodeURIComponent(m[1]) };
                const v = validate('search.index-document@1', doc);
                if (!v.valid) return send(422, { code: 'search.bad_document', errors: v.errors });
                docs.set(doc.id, doc);
                puts.push(doc.id);
                return send(200, { outcome: 'applied' });
            }
            if (m && req.method === 'DELETE') {
                const id = decodeURIComponent(m[1]);
                docs.set(id, { id, revision: Number(u.searchParams.get('revision')), deleted: true });
                return send(200, { outcome: 'applied' });
            }
            return send(404, { code: 'route.not_found' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ docs, puts, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

(async () => {
    const search = await startSearch();
    const profile = (id, name, extra = {}) => ({ id, name, vendor: 'Acme', description: `${name} drives in your browser.`, kind: 'bridge', capabilities: ['drive', 'camera'], ...extra });
    let catalogue = [modelOf(profile('cozmo', 'Cozmo', { vendor: 'Digital Dream Labs' })), modelOf(profile('looi', 'LOOI'))];
    const config = { search: { url: search.url }, oauth: { clientSecret: 'x', clientId: 'bot' }, network: { internalUrl: 'http://network.test' }, baseUrl: 'https://openvibe.bot' };
    const index = createModelSearchIndex({ config, tokens: { authHeaders: async () => ({ authorization: 'Bearer svc-bot' }) }, models: async () => catalogue, log: { warn() {} } });

    await check('every model is a valid document at /models/<id>', async () => {
        const r = await index.run();
        assert.strictEqual(r.upserted, 2, JSON.stringify(r));
        const doc = search.docs.get('cozmo');
        assert.strictEqual(doc.canonical_url, 'https://openvibe.bot/models/cozmo');
        assert.strictEqual(doc.title, 'Cozmo (Digital Dream Labs)');
        assert.strictEqual(doc.facets.kind, 'robot_model');
    });

    await check('unchanged is not sent again; a model gone from the catalogue is tombstoned', async () => {
        await index.run();
        assert.strictEqual(search.puts.length, 2);
        catalogue = catalogue.filter((m) => m.id !== 'looi');
        const r = await index.run();
        assert.strictEqual(r.deleted, 1);
        assert.deepStrictEqual(search.docs.get('looi'), { id: 'looi', revision: 2, deleted: true });
    });

    await check('off without BOT_SEARCH_URL', async () => {
        const off = createModelSearchIndex({ config: { ...config, search: { url: '' } }, models: async () => catalogue });
        assert.strictEqual(off.enabled, false);
        assert.strictEqual(await off.run(), null);
    });

    await search.close();
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})();
