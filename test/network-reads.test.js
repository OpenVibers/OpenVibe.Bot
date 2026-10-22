'use strict';
// The front page's reads from OpenVibe.Search (server/web/network-reads.js): only public https documents become
// rows, an answer is cached, a failure leaves the page without the section, and nothing is fetched unconfigured.
const assert = require('assert');
const { check, done } = require('./helpers/app');
const { createNetworkReads, jobOf } = require('../server/web/network-reads');

const quiet = { warn() {} };
const doc = (o) => ({ owner: 'work', type: 'job', visibility: 'public', title: 'Robotics Engineer at Acme', canonical_url: 'https://openvibe.work/jobs/job_1', facets: { location: 'Munich', remote: false, type: 'Full Time, professional' }, ...o });

(async () => {
    await check('jobOf: title, https link and the facets the page shows; anything else is dropped', async () => {
        assert.deepStrictEqual(jobOf(doc()), { title: 'Robotics Engineer at Acme', url: 'https://openvibe.work/jobs/job_1', location: 'Munich', remote: false, type: 'Full Time' });
        assert.strictEqual(jobOf(doc({ canonical_url: 'javascript:alert(1)' })), null);
        assert.strictEqual(jobOf(doc({ canonical_url: 'http://openvibe.work/jobs/job_1' })), null);
        assert.strictEqual(jobOf(doc({ title: '   ' })), null);
        assert.strictEqual(jobOf(doc({ facets: { remote: true } })).remote, true);
    });

    await check('no search URL: no fetch, no rows', async () => {
        let calls = 0;
        const reads = createNetworkReads({ searchUrl: '', fetchImpl: async () => { calls++; return null; }, log: quiet });
        assert.deepStrictEqual(await reads.jobs(), []);
        assert.strictEqual(calls, 0);
    });

    await check('one anonymous query, then the cached answer', async () => {
        const urls = [];
        const fetchImpl = async (url) => { urls.push(url); return { ok: true, json: async () => ({ results: [doc(), doc({ canonical_url: 'ftp://x' })] }) }; };
        const reads = createNetworkReads({ searchUrl: 'https://search.example/', fetchImpl, log: quiet });
        assert.strictEqual((await reads.jobs()).length, 1);
        assert.strictEqual((await reads.jobs()).length, 1);
        assert.strictEqual(urls.length, 1, 'cached');
        assert.match(urls[0], /^https:\/\/search\.example\/api\/v1\/search\?q=robotics&owner=work&type=job&limit=6$/);
    });

    await check('Search failing: the page gets no rows and does not throw', async () => {
        const reads = createNetworkReads({ searchUrl: 'https://search.example', fetchImpl: async () => ({ ok: false, status: 503 }), log: quiet });
        assert.deepStrictEqual(await reads.jobs(), []);
        const broken = createNetworkReads({ searchUrl: 'https://search.example', fetchImpl: async () => { throw new Error('down'); }, log: quiet });
        assert.deepStrictEqual(await broken.jobs(), []);
    });

    done();
})();
