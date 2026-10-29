'use strict';
// Community robot profiles (plan T15: "people submit bots and guides and Bot connects them", reviewed and signed before
// they run): submit at /robots/submit, see it at /robots/submissions, an admin approves (Bot signs it, Ed25519 over its
// canonical JSON) or rejects with a note; an approved profile is in the catalogue (/models "From the community",
// /robots/new, the API with its signature and Bot's public key) and robots can be added with it.
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/app');
const { canonicalJson, loadKey } = require('../server/submissions');

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const KEY = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');

const PROFILE = {
    id: 'community.ballbot', version: 1, name: 'Ballbot', vendor: 'Mia', kind: 'onboard',
    description: 'A self-balancing ball robot on an ESP32, driven by a community Node plugin.',
    capabilities: ['drive.differential', 'battery'],
    mapping: { driver: 'plugin', plugin: 'ballbot' },
    commands: { drive: { axes: { throttle: [-1, 1], steer: [-1, 1] } } },
    widgets: [
        { type: 'drive', capability: 'drive.differential', label: 'Drive', order: 1, command: { kind: 'drive' } },
        { type: 'battery', capability: 'battery', label: 'Battery', order: 2 },
    ],
    limits: { max_speed: 0.5, max_turn: 0.6, max_command_ms: 300, heartbeat_ms: 1000 },
};

(async () => {
    await check('canonical JSON sorts keys at every depth; the key loads from base64 PEM, raw PEM with \\n, or refuses', () => {
        assert.strictEqual(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: 'é' } }), '{"a":{"c":"é","d":[2,{"x":2,"y":1}]},"b":1}');
        const k = loadKey(KEY);
        assert.match(k.keyId, /^[0-9a-f]{16}$/);
        assert.strictEqual(loadKey(privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n')).keyId, k.keyId);
        assert.strictEqual(loadKey(''), null);
        assert.throws(() => loadKey('bm90IGEga2V5'), /not a private key/);
        const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
        assert.throws(() => loadKey(rsa), /Ed25519/);
    });

    const t = await boot({ env: { BOT_PROFILE_SIGNING_KEY: KEY } });
    const mia = t.network.newUser('mia');
    const sam = t.network.newUser('sam');
    const ada = t.network.newUser('ada');
    ada.role = 'admin';
    const cookie = (u) => ({ Cookie: `ov_token=${t.network.signUser(u)}` });
    const get = (p, u) => fetch(t.base + p, { redirect: 'manual', headers: u ? cookie(u) : {} });
    const post = (p, u, form, headers = {}) => fetch(t.base + p, {
        method: 'POST', redirect: 'manual', body: new URLSearchParams(form).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(u ? cookie(u) : {}), ...headers },
    });
    const submit = (u, profile, extra = {}, headers = {}) => post('/robots/submit', u, { profile: typeof profile === 'string' ? profile : JSON.stringify(profile), driver_url: 'https://github.com/mia/ballbot-driver', guide_url: 'https://openvibe.wiki/robots/ballbot', license: 'MIT', notes: 'Tested on two boards.', ...extra }, headers);

    await check('/robots/submit: signed in only; a profile template; refusals come back on the form', async () => {
        // A gated page answers here with noindex (SEO-7), never a redirect off the site.
        assert.strictEqual((await get('/robots/submit')).status, 401);
        const form = await (await get('/robots/submit', mia)).text();
        assert.ok(form.includes('name="profile"') && form.includes('community.my-robot') && form.includes('<option value="MIT"'));
        const bad = await submit(mia, '{ not json');
        assert.strictEqual(bad.status, 422);
        assert.match(await bad.text(), /not valid JSON/);
        const notCommunity = await submit(mia, { ...PROFILE, id: 'ballbot' });
        assert.strictEqual(notCommunity.status, 422);
        assert.match(await notCommunity.text(), /community\.&lt;name&gt;|community\.<name>/);
        const noSource = await submit(mia, PROFILE, { driver_url: '' });
        assert.strictEqual(noSource.status, 422, 'a plugin-driven robot needs its plugin\'s source');
        const http = await submit(mia, PROFILE, { driver_url: 'http://example.test/x' });
        assert.strictEqual(http.status, 422, 'https only');
        const broken = await submit(mia, { ...PROFILE, mapping: { driver: 'plugin' } });
        assert.strictEqual(broken.status, 422, 'a plugin driver names its plugin');
        assert.strictEqual((await submit(mia, PROFILE, { license: 'WTFPL' })).status, 422);
        assert.strictEqual((await submit(mia, PROFILE, {}, { Origin: 'https://evil.test' })).status, 403);
    });

    let subId;
    await check('a good submission waits for review; someone else cannot take its id meanwhile', async () => {
        const r = await submit(mia, PROFILE);
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.get('location'), '/robots/submissions');
        const row = await t.db.maybe("SELECT * FROM profile_submissions WHERE profile_id = 'community.ballbot' AND status = 'pending'");
        assert.ok(row && row.submitter_subject === mia.subject && row.license === 'MIT' && row.driver_url === 'https://github.com/mia/ballbot-driver');
        subId = row.id;
        const mine = await (await get('/robots/submissions', mia)).text();
        assert.ok(mine.includes('community.ballbot') && mine.includes('Waiting for review') && !mine.includes('Approve and sign'), 'not a reviewer');
        assert.strictEqual((await submit(sam, PROFILE)).status, 409);
        assert.strictEqual((await get('/api/v1/profiles/community.ballbot')).status, 404, 'not in the catalogue yet');
    });

    await check('only an admin reviews; a rejection needs a note', async () => {
        assert.strictEqual((await post(`/robots/submissions/${subId}/review`, mia, { decision: 'approve' })).status, 403);
        const queue = await (await get('/robots/submissions', ada)).text();
        assert.ok(queue.includes('Waiting for review') && queue.includes('Approve and sign') && queue.includes('From @mia'));
        assert.strictEqual((await post(`/robots/submissions/${subId}/review`, ada, { decision: 'reject' })).status, 422);
    });

    await check('approval signs it and puts it in the catalogue: API with signature, /models, /robots/new, a robot', async () => {
        const r = await post(`/robots/submissions/${subId}/review`, ada, { decision: 'approve', note: 'Looks safe.' });
        assert.strictEqual(r.status, 303);
        const api = (await t.call('GET', '/api/v1/profiles/community.ballbot', { token: null })).json;
        assert.strictEqual(api.profile.name, 'Ballbot');
        const key = (await t.call('GET', '/api/v1/profiles/signing-key', { token: null })).json.key;
        assert.strictEqual(key.alg, 'Ed25519');
        assert.strictEqual(api.signature.key_id, key.key_id);
        const ok = crypto.verify(null, Buffer.from(canonicalJson(api.profile)), crypto.createPublicKey(key.public_key_pem), Buffer.from(api.signature.value, 'base64'));
        assert.ok(ok, 'the signature verifies with Bot\'s published key');
        const models = await (await get('/models')).text();
        assert.ok(models.includes('From the community') && models.includes('href="/models/community.ballbot"'));
        const page = await (await get('/models/community.ballbot')).text();
        assert.ok(page.includes('Submitted by @mia') && page.includes('https://github.com/mia/ballbot-driver') && page.includes(key.key_id));
        assert.ok(page.includes(`openvibe-node profile verify community.ballbot --key-id ${key.key_id}`), 'the model page says how to check it on a machine');
        assert.match(await (await get('/robots/new?profile=community.ballbot', sam)).text(), /value="community\.ballbot" checked/);
        const made = await t.call('POST', '/api/v1/robots', { user: sam, body: { name: 'My ballbot', profile_id: 'community.ballbot' } });
        assert.strictEqual(made.status, 201, made.text);
        assert.strictEqual((await submit(sam, { ...PROFILE, version: 2 })).status, 409, 'the id is mia\'s now');
        assert.strictEqual((await submit(mia, PROFILE)).status, 409, 'version 1 is taken: a new one needs version 2');
        assert.strictEqual((await submit(mia, { ...PROFILE, version: 2, name: 'Ballbot 2' })).status, 303, 'its submitter sends a new version');
    });

    await check('account deletion: the person\'s waiting submissions go; the approved profile stays, authorless', async () => {
        const accountData = require('../server/account-data').create({ domain: t.domain, log: { log() {}, warn() {} } });
        const out = await accountData.erase([mia.subject]);
        assert.strictEqual(out.erased.profile_submissions, 1, 'version 2, still waiting, is deleted');
        const left = await t.db.many("SELECT status, submitter_subject FROM profile_submissions WHERE profile_id = 'community.ballbot'");
        assert.deepStrictEqual(left.map((r) => [r.status, r.submitter_subject]), [['approved', null]]);
        assert.strictEqual((await t.call('GET', '/api/v1/profiles/community.ballbot', { token: null })).status, 200, 'robots keep their profile');
    });

    await t.close();
    done();
})();
