'use strict';
// The usage relay authenticates to OpenVibe.Billing (plan T14 L1) the same way Bot talks to OpenRestream: with an
// operator BOT_BILLING_TOKEN when one is set, otherwise a Network service token it mints for audience
// openvibe.billing (capability billing.usage.record) from its OAuth client, cached by the shared token client
// until 60 s before expiry. Here the relay runs against a fake Network token endpoint and a fake Billing: with
// only BOT_BILLING_URL set it mints one token for the sweep, posts each queued reading once with it, re-mints
// after expiry; a 401 from Billing drops the cached token and a 401/5xx keeps every reading queued (never
// dropped, never rejected); an operator token overrides minting; and with the URL unset the relay makes no call
// at all.
const assert = require('assert');
const { check, done } = require('./helpers/app');
const { testDb } = require('./helpers/db');
const { secondReading, enqueue, createUsageRelay, TABLE } = require('../server/jobs/metering');

// Network's grant to the `bot` client on audience openvibe.billing (OpenVibe.Network DEFAULT_GRANTS).
const MINTED_AUDIENCE = 'openvibe.billing';
const MINTED_SCOPE = 'billing.usage.record';
const BILLING_URL = 'http://billing.test';
const NETWORK_URL = 'http://network.test';
const STARTED_MS = 1790935200000;

const quiet = { warn() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const config = (billing = {}) => ({
    oauth: { clientId: 'bot', clientSecret: 'shh' },
    network: { internalUrl: NETWORK_URL },
    billing: { url: BILLING_URL, token: '', intervalMs: 100, timeoutMs: 2000, ...billing },
});

/**
 * A fake Network token endpoint (POST /oauth/token → mint_1, mint_2, …) and a fake Billing (POST
 * /api/v1/usage), behind one fetch. tokenCalls records every client-credentials request; posts records every
 * usage post ({ auth, status, body }); billingStatus() decides each post's status.
 */
function fakeServices({ expiresIn = 300, billingStatus = () => 201 } = {}) {
    const tokenCalls = [];
    const posts = [];
    let minted = 0;
    const fetchImpl = async (url, init) => {
        if (url === `${NETWORK_URL}/oauth/token`) {
            const body = Object.fromEntries(new URLSearchParams(init.body));
            tokenCalls.push({ client_id: body.client_id, client_secret: body.client_secret, audience: body.audience, scope: body.scope, grant_type: body.grant_type });
            if (body.client_secret !== 'shh') return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });
            return new Response(JSON.stringify({ access_token: `mint_${++minted}`, token_type: 'Bearer', expires_in: expiresIn }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url === `${BILLING_URL}/api/v1/usage`) {
            const status = billingStatus();
            posts.push({ auth: init.headers.Authorization, status, body: JSON.parse(init.body) });
            return new Response('{}', { status });
        }
        throw new Error(`unexpected fetch ${url}`);
    };
    return { fetchImpl, tokenCalls, posts };
}

(async () => {
    const store = await testDb();
    const db = store.db;
    // One relay sweep at a time: readings queued inside a transaction, exactly as dispatch/job_exit do.
    const queue = (prefix, seconds) => db.tx(async (t) => {
        for (const n of seconds) {
            await enqueue(t, secondReading({ jobId: `job_${prefix}`, n, startedMs: STARTED_MS, nodeId: 'dev_test' }), Date.now());
        }
    });
    const countLike = (prefix, where) => db.value(`SELECT count(*) FROM ${TABLE} WHERE event_id LIKE $1 AND ${where}`, [`run:job_${prefix}:%`]).then(Number);
    const pending = (prefix) => countLike(prefix, 'sent_at IS NULL AND rejected_at IS NULL');
    const rejected = (prefix) => countLike(prefix, 'rejected_at IS NOT NULL');
    const sent = (prefix) => countLike(prefix, 'sent_at IS NOT NULL');

    await check('with only BOT_BILLING_URL set the relay mints one token and posts each reading once with it', async () => {
        const svc = fakeServices({ expiresIn: 61 });
        const clock = { t: Date.now() };
        const relay = createUsageRelay({ db, config: config(), fetchImpl: svc.fetchImpl, now: () => clock.t, log: quiet });
        assert.strictEqual(relay.enabled, true);

        await queue('mint', [0, 1, 2]);
        const before = svc.tokenCalls.length;
        await relay.flush();
        assert.deepStrictEqual(svc.tokenCalls.slice(before),
            [{ client_id: 'bot', client_secret: 'shh', audience: MINTED_AUDIENCE, scope: MINTED_SCOPE, grant_type: 'client_credentials' }]);
        assert.strictEqual(svc.posts.length, 3);
        assert.deepStrictEqual(svc.posts.map((p) => p.auth), ['Bearer mint_1', 'Bearer mint_1', 'Bearer mint_1']);
        assert.deepStrictEqual(svc.posts.map((p) => p.body.idempotency_key), ['run:job_mint:0', 'run:job_mint:1', 'run:job_mint:2']);
        assert.strictEqual(await pending('mint'), 0);
        assert.strictEqual(await sent('mint'), 3);
        assert.strictEqual(await rejected('mint'), 0);

        // A second read is served by the same cached token, not a second mint.
        await queue('mint2', [0]);
        await relay.flush();
        assert.strictEqual(svc.tokenCalls.length, before + 1, 'the cached token was reused');
        assert.strictEqual(svc.posts.at(-1).auth, 'Bearer mint_1');

        // Past its expiry (expires_in 61 ⇒ cached only ~1 s) the relay mints again.
        await sleep(1100);
        await queue('mint3', [0]);
        await relay.flush();
        assert.strictEqual(svc.tokenCalls.length, before + 2, 'the expired token was replaced');
        assert.strictEqual(svc.posts.at(-1).auth, 'Bearer mint_2');
        assert.strictEqual(await pending('mint3'), 0);
        await relay.stop();
    });

    await check('a 401 or 5xx from Billing keeps every reading queued, and the 401 drops the minted token', async () => {
        const svc = fakeServices();
        const clock = { t: Date.now() };
        let mode = 503;
        const relay = createUsageRelay({ db, config: config(), fetchImpl: fakeServices200(svc, () => mode), now: () => clock.t, log: quiet });
        assert.strictEqual(relay.enabled, true);

        await queue('down', [0, 1]);
        await relay.flush();   // 5xx
        assert.strictEqual(await pending('down'), 2, 'a 5xx leaves both readings queued');
        assert.strictEqual(await rejected('down'), 0);
        clock.t += 2000;
        await relay.flush();   // 5xx again, after the retry backoff
        assert.strictEqual(await pending('down'), 2);
        assert.strictEqual(await rejected('down'), 0);

        const mintedBefore = svc.tokenCalls.length;
        const auth401 = svc.posts.at(-1).auth;
        mode = 401;
        clock.t += 10000;
        await relay.flush();
        assert.strictEqual(await pending('down'), 2, 'a 401 leaves both readings queued');
        assert.strictEqual(await rejected('down'), 0);

        mode = 201;
        clock.t += 60000;
        await relay.flush();
        assert.strictEqual(await pending('down'), 0);
        assert.strictEqual(await rejected('down'), 0);
        assert.strictEqual(svc.tokenCalls.length, mintedBefore + 1, 'the 401 dropped the cached token, so one fresh mint served the retry');
        assert.notStrictEqual(svc.posts.at(-1).auth, auth401, 'the retry carried a freshly minted token');
        assert.deepStrictEqual(svc.posts.filter((p) => p.status === 201).map((p) => p.auth), ['Bearer mint_2', 'Bearer mint_2']);
        await relay.stop();
    });

    await check('BOT_BILLING_TOKEN overrides minting: it is sent verbatim and Network is never asked', async () => {
        const svc = fakeServices();
        const relay = createUsageRelay({ db, config: config({ token: 'operator-minted' }), fetchImpl: svc.fetchImpl, now: () => Date.now(), log: quiet });
        assert.strictEqual(relay.enabled, true);
        await queue('static', [0]);
        await relay.flush();
        assert.strictEqual(svc.tokenCalls.length, 0, 'BOT_BILLING_TOKEN was set: nothing was minted');
        assert.deepStrictEqual(svc.posts.map((p) => p.auth), ['Bearer operator-minted']);
        assert.strictEqual(await pending('static'), 0);
        await relay.stop();
    });

    await check('with BOT_BILLING_URL unset the relay is off and makes no call; so is a URL with no way to authenticate', async () => {
        const svc = fakeServices();
        const noCall = async (url) => { throw new Error(`the relay called ${url} while off`); };
        const off = createUsageRelay({ db, config: config({ url: '' }), fetchImpl: noCall, now: () => Date.now(), log: quiet });
        assert.strictEqual(off.enabled, false);
        assert.deepStrictEqual(await off.flush(), { sent: 0, failed: 0, rejected: 0 });
        off.start(); off.kick(); await off.stop();
        await queue('off', [0]);
        assert.strictEqual(await pending('off'), 1, 'readings wait while the URL is unset');
        // A URL but neither an operator token nor the Network client credentials: still off, still nothing sent.
        const noCreds = createUsageRelay({ db, config: { oauth: {}, network: {}, billing: { url: BILLING_URL, token: '', intervalMs: 100, timeoutMs: 2000 } }, fetchImpl: noCall, now: () => Date.now(), log: quiet });
        assert.strictEqual(noCreds.enabled, false);
        assert.deepStrictEqual(await noCreds.flush(), { sent: 0, failed: 0, rejected: 0 });
        assert.ok(svc.tokenCalls.length === 0 && svc.posts.length === 0);
    });

    await store.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

/** The fake Network endpoint with Billing's status coming from `mode()` (so a test can flip it mid-run). */
function fakeServices200(svc, mode) {
    return async (url, init) => {
        if (url === `${BILLING_URL}/api/v1/usage`) {
            const status = mode();
            svc.posts.push({ auth: init.headers.Authorization, status, body: JSON.parse(init.body) });
            return new Response('{}', { status });
        }
        return svc.fetchImpl(url, init);
    };
}
