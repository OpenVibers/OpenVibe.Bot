'use strict';
// The publish key is an OpenRestream ingest key (T15 R5): OpenRestream's WHIP worker admits only keys in its own store, so
// pairing creates the robot's OpenRestream stream (external ref bot:robot:<id>) and hands the device the key OpenRestream
// returns; a re-pair and a credential rotation rotate that stream's key, a revocation rotates it with no grace
// and ends the session, a robot's removal also archives the stream when nothing is live. OpenRestream refusing or
// not answering is a clean error with nothing half-written; Bot's token for OpenRestream is never logged or
// answered. Without a static BOT_OPENRE_TOKEN Bot mints its own from its Network client (audience
// openvibe.openre), and a 401 makes it mint once more and retry; with neither credential devices pair without
// video and Bot mints no key of its own.
const assert = require('assert');
const { serviceAuth } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const { createOpenRe } = require('../server/openre/client');

// Network's grant to the `bot` client on audience openvibe.openre (OpenVibe.Network DEFAULT_GRANTS).
const MINTED_AUDIENCE = 'openvibe.openre';
const MINTED_SCOPE = 'openre.stream.read openre.stream.write openre.key.rotate openre.session.read openre.output.read openre.output.write';

const WHIP_BASE = 'https://ingest.test/whip';

(async () => {
    const t = await boot({ env: { BOT_WHIP_BASE: WHIP_BASE } });
    const alex = t.network.newUser('alex');
    const responses = [];
    const call = async (...a) => { const r = await t.call(...a); responses.push(r.text); return r; };
    const redeem = (body) => call('POST', '/api/v1/pair', { token: null, body });
    const robotRow = (id) => t.db.maybe('SELECT * FROM robots WHERE id = $1', [id]);
    const deviceRow = (id) => t.db.maybe('SELECT * FROM devices WHERE id = $1', [id]);
    const callsSince = (n) => t.openre.calls.slice(n);
    const newCode = async (robotId) => (await call('POST', `/api/v1/robots/${robotId}/pairing-code`, { user: alex })).json;
    async function pairedRobot() {
        const { robot, pairing } = await t.robot(alex);
        const paired = await redeem({ robot: robot.id, code: pairing.code });
        assert.strictEqual(paired.status, 201, paired.text);
        return { robot, paired: paired.json };
    }

    await check('the client is null without a URL, a token or a Network client, and its errors never carry the token', async () => {
        assert.strictEqual(createOpenRe({ openre: { url: '', token: 'x', timeoutMs: 100 } }), null);
        // No static token and no Network client credentials: nothing to authenticate with.
        assert.strictEqual(createOpenRe({ openre: { url: 'http://openre.test', token: '', timeoutMs: 100 } }), null);
        assert.strictEqual(createOpenRe({ openre: { url: 'http://openre.test', token: '', timeoutMs: 100 }, network: { internalUrl: 'http://network.test' }, oauth: { clientId: 'bot' } }), null);
        assert.strictEqual(createOpenRe({ openre: { url: 'http://openre.test', token: '', timeoutMs: 100 }, network: {}, oauth: { clientId: 'bot', clientSecret: 'shh' } }), null);
        // A URL is still required even with a Network client.
        assert.strictEqual(createOpenRe({ openre: { url: '', token: '', timeoutMs: 100 }, network: { internalUrl: 'http://network.test' }, oauth: { clientId: 'bot', clientSecret: 'shh' } }), null);
        const secret = 'ovt_never_shown_anywhere';
        const down = createOpenRe({ openre: { url: 'http://openre.test', token: secret, timeoutMs: 100 } }, { fetchImpl: async () => { throw new Error(`connect ECONNREFUSED Bearer ${secret}`); } });
        const e = await down.create({}, alex.subject).then(() => null, (x) => x);
        assert.strictEqual(e.status, 503);
        assert.strictEqual(e.code, 'bot.openre_unavailable');
        assert.ok(!JSON.stringify({ m: e.message, d: e.detail, x: e.extra }).includes(secret));
    });

    await check('migration 0003 adds robots.openre_stream_id and devices.publish_key_hint', async () => {
        const cols = await t.db.many(
            `SELECT table_name, column_name FROM information_schema.columns
             WHERE (table_name = 'robots' AND column_name = 'openre_stream_id') OR (table_name = 'devices' AND column_name = 'publish_key_hint')`);
        assert.deepStrictEqual(cols.map((c) => `${c.table_name}.${c.column_name}`).sort(), ['devices.publish_key_hint', 'robots.openre_stream_id']);
    });

    await check('the panel video look-up reads the stream\'s open session and its playback descriptor, always as the owner', async () => {
        const { robot } = await pairedRobot();
        const streamId = (await robotRow(robot.id)).openre_stream_id;
        // The session's viewer URL, keyed by its playback id; the calls act for the robot's owner.
        const session = t.openre.goLive(streamId);
        assert.strictEqual(await t.domain.video.live(robot.id), `ws://127.0.0.1:9936/w/${session.id}`);
        const list = t.openre.calls.filter((c) => c.path === '/api/v1/sessions').at(-1);
        assert.strictEqual(list.query, `?stream_id=${encodeURIComponent(streamId)}&state=open`);
        assert.strictEqual(list.subject, alex.subject);
        assert.strictEqual(list.authorization, `Bearer ${t.openre.token}`);
        const playback = t.openre.calls.filter((c) => c.path === `/api/v1/sessions/${session.id}/playback`).at(-1);
        assert.strictEqual(playback.subject, alex.subject);
        assert.ok(!JSON.stringify(playback).includes('ork_'), 'never the ingest key');
        // A live session that is not WebRTC has no viewer URL, and a robot with no stream asks nothing.
        t.openre.endLive(session.id);
        const rtmp = t.openre.goLive(streamId, { protocol: 'rtmp' });
        assert.strictEqual(await t.domain.video.live(robot.id), null, 'a non-WebRTC session is passed over');
        t.openre.endLive(rtmp.id);
        const quiet = t.openre.calls.length;
        assert.strictEqual(await t.domain.video.live(robot.id), null);
        assert.strictEqual(t.openre.calls.length, quiet + 1, 'nothing open: only the session list is read');
        const { robot: bare } = await t.robot(alex, { name: 'No stream yet' });
        assert.strictEqual(await t.domain.video.live(bare.id), null);
        assert.strictEqual(t.openre.calls.length, quiet + 1, 'no stream: OpenRestream is not asked');
    });

    await check('pairing creates the robot\'s OpenRestream stream and hands the device the ingest key OpenRestream issued', async () => {
        const before = t.openre.calls.length;
        const { robot, paired } = await pairedRobot();
        const calls = callsSince(before);
        assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /api/v1/streams', 'POST /api/v1/streams']);
        assert.strictEqual(calls[0].query, `?external_ref=${encodeURIComponent(`bot:robot:${robot.id}`)}`);
        const create = calls[1];
        assert.strictEqual(create.subject, alex.subject, 'OpenRestream is asked for the robot\'s owner');
        assert.strictEqual(create.authorization, `Bearer ${t.openre.token}`);
        assert.deepStrictEqual(create.body.protocols, ['webrtc']);
        assert.deepStrictEqual(create.body.external_refs, [{ service: 'bot', type: 'robot', id: robot.id, label: robot.name }]);
        assert.match(paired.publish_key, /^ork_[A-Za-z0-9_-]{43}$/);
        assert.ok(t.openre.admits(paired.publish_key), 'OpenRestream admits the publish key');
        assert.strictEqual(paired.whip_url, `${WHIP_BASE}/${paired.publish_key}`);
        assert.ok(!('video' in paired));
        const stream = [...t.openre.streams.values()].find((s) => s.refs.some((r) => r.id === robot.id));
        const r = await robotRow(robot.id);
        assert.strictEqual(r.openre_stream_id, stream.id, 'only the stream id is stored');
        const d = await deviceRow(paired.device_id);
        assert.strictEqual(d.publish_key_hint, paired.publish_key.slice(-4));
        assert.strictEqual(d.publish_key_hash, null, 'Bot mints and hashes no publish key');
        assert.ok(!JSON.stringify([r, d]).includes(paired.publish_key), 'the key is not stored');
    });

    await check('re-pairing a robot rotates its stored stream instead of creating another', async () => {
        const { robot, paired } = await pairedRobot();
        const streamId = (await robotRow(robot.id)).openre_stream_id;
        const before = t.openre.calls.length;
        const again = await redeem({ robot: robot.id, code: (await newCode(robot.id)).code });
        assert.strictEqual(again.status, 201, again.text);
        const calls = callsSince(before).filter((c) => c.path.startsWith('/api/v1/streams'));
        assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /api/v1/streams/${streamId}/keys/rotate`]);
        assert.deepStrictEqual(calls[0].body, { grace_seconds: 0, end_sessions: false });
        assert.ok(t.openre.admits(again.json.publish_key));
        assert.ok(!t.openre.admits(paired.publish_key), 'the first device\'s key stops working');
        assert.strictEqual((await robotRow(robot.id)).openre_stream_id, streamId);
        assert.strictEqual((await deviceRow(paired.device_id)).publish_key_hint, null, 'the first device holds no key any more');
    });

    await check('with no stored stream id the stream is found by its external ref and rotated, never created twice', async () => {
        const { robot } = await pairedRobot();
        const streamId = (await robotRow(robot.id)).openre_stream_id;
        await t.db.query('UPDATE robots SET openre_stream_id = NULL WHERE id = $1', [robot.id]);
        const before = t.openre.calls.length;
        const again = await redeem({ robot: robot.id, code: (await newCode(robot.id)).code });
        assert.strictEqual(again.status, 201, again.text);
        assert.deepStrictEqual(callsSince(before).filter((c) => c.path.startsWith('/api/v1/streams')).map((c) => `${c.method} ${c.path}`),
            ['GET /api/v1/streams', `POST /api/v1/streams/${streamId}/keys/rotate`]);
        assert.strictEqual((await robotRow(robot.id)).openre_stream_id, streamId);
        assert.ok(t.openre.admits(again.json.publish_key));
    });

    await check('a credential rotation rotates the stream key with the credential\'s grace', async () => {
        const { robot, paired } = await pairedRobot();
        const streamId = (await robotRow(robot.id)).openre_stream_id;
        const before = t.openre.calls.length;
        const rot = await call('POST', `/api/v1/devices/${paired.device_id}/rotate`, { user: alex });
        assert.strictEqual(rot.status, 200, rot.text);
        const calls = callsSince(before);
        assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /api/v1/streams/${streamId}/keys/rotate`]);
        assert.deepStrictEqual(calls[0].body, { grace_seconds: 60, end_sessions: false });
        assert.notStrictEqual(rot.json.publish_key, paired.publish_key);
        assert.strictEqual(rot.json.whip_url, `${WHIP_BASE}/${rot.json.publish_key}`);
        assert.ok(t.openre.admits(rot.json.publish_key), 'the new key is admitted');
        assert.ok(t.openre.admits(paired.publish_key), 'the old key publishes through the grace');
        assert.strictEqual((await deviceRow(paired.device_id)).publish_key_hint, rot.json.publish_key.slice(-4));
    });

    await check('revoking a device revokes its key at once and ends its live session', async () => {
        const { robot, paired } = await pairedRobot();
        const streamId = (await robotRow(robot.id)).openre_stream_id;
        const before = t.openre.calls.length;
        const r = await call('POST', `/api/v1/devices/${paired.device_id}/revoke`, { user: alex });
        assert.strictEqual(r.status, 200, r.text);
        const calls = callsSince(before);
        assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /api/v1/streams/${streamId}/keys/rotate`]);
        assert.deepStrictEqual(calls[0].body, { grace_seconds: 0, end_sessions: true });
        assert.ok(!t.openre.admits(paired.publish_key));
        assert.ok(!r.text.includes('ork_'), 'the throwaway key is answered to no one');
        assert.strictEqual((await deviceRow(paired.device_id)).publish_key_hint, null);
    });

    await check('a revocation OpenRestream does not answer still revokes the device; the owner\'s retry revokes the key', async () => {
        const { robot, paired } = await pairedRobot();
        t.openre.failNext(503);
        const r = await call('POST', `/api/v1/devices/${paired.device_id}/revoke`, { user: alex });
        assert.strictEqual(r.status, 503, r.text);
        assert.strictEqual(r.json.code, 'bot.openre_unavailable');
        const d = await deviceRow(paired.device_id);
        assert.ok(d.revoked_at, 'the device is revoked regardless');
        assert.ok(d.publish_key_hint, 'the key is still owed a revocation');
        assert.ok(t.openre.admits(paired.publish_key));
        const retry = await call('POST', `/api/v1/devices/${paired.device_id}/revoke`, { user: alex });
        assert.strictEqual(retry.status, 200, retry.text);
        assert.ok(!t.openre.admits(paired.publish_key));
        assert.ok((await robotRow(robot.id)).openre_stream_id);
    });

    await check('removing a robot revokes its stream key and archives the stream when nothing is live', async () => {
        const { robot, paired } = await pairedRobot();
        const streamId = (await robotRow(robot.id)).openre_stream_id;
        const before = t.openre.calls.length;
        const r = await call('DELETE', `/api/v1/robots/${robot.id}`, { user: alex });
        assert.strictEqual(r.status, 204, r.text);
        const calls = callsSince(before);
        assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /api/v1/streams/${streamId}/keys/rotate`, `DELETE /api/v1/streams/${streamId}`]);
        assert.deepStrictEqual(calls[0].body, { grace_seconds: 0, end_sessions: true });
        assert.strictEqual(t.openre.streams.get(streamId).state, 'archived');
        assert.ok(!t.openre.admits(paired.publish_key));
        assert.strictEqual(await robotRow(robot.id), null);
    });

    await check('removing a robot whose stream is live ends the session and leaves the archive to OpenRestream\'s refusal', async () => {
        const { robot, paired } = await pairedRobot();
        const streamId = (await robotRow(robot.id)).openre_stream_id;
        t.openre.streams.get(streamId).live = true;
        const before = t.openre.calls.length;
        const r = await call('DELETE', `/api/v1/robots/${robot.id}`, { user: alex });
        assert.strictEqual(r.status, 204, r.text);
        assert.deepStrictEqual(callsSince(before).map((c) => `${c.method} ${c.path}`), [`POST /api/v1/streams/${streamId}/keys/rotate`],
            'no DELETE while a session is ending');
        assert.ok(!t.openre.admits(paired.publish_key));
        assert.strictEqual(await robotRow(robot.id), null);
    });

    for (const [what, fault, status, code] of [
        ['a 5xx', 500, 503, 'bot.openre_unavailable'],
        ['a 4xx', 403, 502, 'bot.openre_refused'],
        ['a timeout', 'hang', 503, 'bot.openre_unavailable'],
    ]) {
        await check(`OpenRestream answering ${what} at pairing fails cleanly: the code stays usable and no device is made`, async () => {
            const { robot, pairing } = await t.robot(alex);
            const devicesBefore = Number((await t.db.maybe('SELECT count(*) AS n FROM devices')).n);
            t.openre.failNext(fault);
            const r = await redeem({ robot: robot.id, code: pairing.code });
            t.openre.failNext(null);
            assert.strictEqual(r.status, status, r.text);
            assert.strictEqual(r.json.code, code);
            if (fault === 403) assert.match(r.json.detail, /403 openre\.forbidden/, 'OpenRestream\'s problem code is surfaced');
            assert.ok(!r.text.includes(t.openre.token));
            assert.strictEqual(Number((await t.db.maybe('SELECT count(*) AS n FROM devices')).n), devicesBefore, 'no device row');
            assert.strictEqual((await robotRow(robot.id)).openre_stream_id, null, 'no stream id stored');
            const code_ = await t.db.maybe('SELECT used_at, tries FROM pairing_codes WHERE robot_id = $1', [robot.id]);
            assert.strictEqual(code_.used_at, null, 'the code is not spent');
            const retry = await redeem({ robot: robot.id, code: pairing.code });
            assert.strictEqual(retry.status, 201, retry.text);
            assert.ok(t.openre.admits(retry.json.publish_key));
        });
    }

    await check('the first pairing needs openre.stream.read too: a token without it is refused, `openre.stream.*` will do', async () => {
        const { robot, pairing } = await t.robot(alex);
        t.openre.setCaps(['openre.stream.write', 'openre.key.rotate']);
        const r = await redeem({ robot: robot.id, code: pairing.code });
        t.openre.setCaps(['openre.stream.*', 'openre.key.rotate']);
        assert.strictEqual(r.status, 502, r.text);
        assert.strictEqual(r.json.code, 'bot.openre_refused');
        assert.match(r.json.detail, /403 capability\.denied/);
        const retry = await redeem({ robot: robot.id, code: pairing.code });
        t.openre.setCaps(null);
        assert.strictEqual(retry.status, 201, retry.text);
        assert.ok(t.openre.admits(retry.json.publish_key));
    });

    await check('a credential rotation OpenRestream refuses changes nothing: the old credential stays the current one', async () => {
        const { paired } = await pairedRobot();
        const before = await deviceRow(paired.device_id);
        t.openre.failNext(500);
        const rot = await call('POST', `/api/v1/devices/${paired.device_id}/rotate`, { user: alex });
        assert.strictEqual(rot.status, 503, rot.text);
        assert.ok(!('credential' in rot.json));
        const after = await deviceRow(paired.device_id);
        assert.strictEqual(after.credential_hash, before.credential_hash);
        assert.strictEqual(after.credential_prev_hash, null);
        assert.strictEqual(after.publish_key_hint, before.publish_key_hint);
        assert.ok(t.openre.admits(paired.publish_key));
    });

    await check('Bot\'s OpenRestream token is never logged and never in an answer; a static token means Network is not asked', async () => {
        assert.ok(t.openre.calls.every((c) => c.authorization === `Bearer ${t.openre.token}` || c.authorization === null));
        assert.ok(!t.logs.join('\n').includes(t.openre.token), 'the token was logged');
        assert.ok(!responses.some((text) => text.includes(t.openre.token)), 'an answer carried the token');
        assert.strictEqual(t.network.tokenCalls.length, 0, 'BOT_OPENRE_TOKEN was set: Bot minted no token of its own');
    });

    await t.close();

    // ── BOT_OPENRE_URL / BOT_OPENRE_TOKEN unset ───────────────────────────────────────────────────
    const u = await boot({ openre: false, env: { BOT_WHIP_BASE: WHIP_BASE } });
    const sam = u.network.newUser('sam');
    await check('without OpenRestream configured a device pairs, rotates and is removed with video reported not configured', async () => {
        const { robot, pairing } = await u.robot(sam);
        const paired = await u.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
        assert.strictEqual(paired.status, 201, paired.text);
        assert.ok(paired.json.credential);
        assert.strictEqual(paired.json.video, 'not_configured');
        assert.ok(!('publish_key' in paired.json) && !('whip_url' in paired.json), paired.text);
        const d = await u.db.maybe('SELECT * FROM devices WHERE id = $1', [paired.json.device_id]);
        assert.strictEqual(d.publish_key_hash, null, 'no local key minted');
        assert.strictEqual(d.publish_key_hint, null);
        const rot = await u.call('POST', `/api/v1/devices/${paired.json.device_id}/rotate`, { user: sam });
        assert.strictEqual(rot.status, 200, rot.text);
        assert.strictEqual(rot.json.video, 'not_configured');
        assert.ok(!('publish_key' in rot.json));
        const rev = await u.call('POST', `/api/v1/devices/${paired.json.device_id}/revoke`, { user: sam });
        assert.strictEqual(rev.status, 200, rev.text);
        const del = await u.call('DELETE', `/api/v1/robots/${robot.id}`, { user: sam });
        assert.strictEqual(del.status, 204, del.text);
    });
    await u.close();

    // ── No static token: Bot mints its own from its Network client ────────────────────────────────
    const m = await boot({ env: { BOT_OPENRE_TOKEN: '' } });
    const mia = m.network.newUser('mia');
    const redeemM = (body) => m.call('POST', '/api/v1/pair', { token: null, body });

    await check('without a static token Bot mints a token for audience openvibe.openre with the Network grant\'s scope', async () => {
        const before = m.network.tokenCalls.length;
        const { robot, pairing } = await m.robot(mia);
        const paired = await redeemM({ robot: robot.id, code: pairing.code });
        assert.strictEqual(paired.status, 201, paired.text);
        assert.ok(paired.json.publish_key && m.openre.admits(paired.json.publish_key), 'the device got an OpenRestream-issued key');
        // One mint serves the whole pairing: the find and the create reuse the cached token.
        assert.deepStrictEqual(m.network.tokenCalls.slice(before),
            [{ client_id: 'bot', audience: MINTED_AUDIENCE, scope: MINTED_SCOPE }]);
        const create = m.openre.calls.at(-1);
        assert.strictEqual(create.method, 'POST');
        assert.strictEqual(create.subject, mia.subject);
        assert.ok(create.authorization.startsWith('Bearer '), 'a bearer was sent');
        assert.notStrictEqual(create.authorization, `Bearer ${m.openre.token}`, 'the static token was not what was sent');
        const v = serviceAuth.verifyServiceToken(create.authorization.slice(7), { publicKey: m.network.publicPem, issuer: m.network.url, audience: MINTED_AUDIENCE });
        assert.ok(v.ok, v.reason);
        assert.strictEqual(v.claims.sub, 'svc:bot');
        assert.deepStrictEqual([...v.claims.cap].sort(), MINTED_SCOPE.split(' ').sort());
    });

    await check('a 401 from OpenRestream drops the minted token and retries the call once', async () => {
        const tokensBefore = m.network.tokenCalls.length;
        const callsBefore = m.openre.calls.length;
        const { robot, pairing } = await m.robot(mia);
        m.openre.failNext(401);
        const paired = await redeemM({ robot: robot.id, code: pairing.code });
        assert.strictEqual(paired.status, 201, paired.text);
        assert.ok(m.openre.admits(paired.json.publish_key));
        assert.strictEqual(m.network.tokenCalls.length - tokensBefore, 1, 'exactly one replacement token was minted');
        const calls = m.openre.calls.slice(callsBefore);
        assert.strictEqual(calls[0].method, 'GET');
        assert.strictEqual(calls[1].method, 'GET');
        assert.strictEqual(calls[1].query, calls[0].query, 'the same call was tried again');
        assert.notStrictEqual(calls[1].authorization, calls[0].authorization, 'the retry carried a fresh token');
    });

    await check('a second 401 is a refusal, not an endless retry', async () => {
        const { robot, pairing } = await m.robot(mia);
        const callsBefore = m.openre.calls.length;
        m.openre.failNext(401, 2);
        const r = await redeemM({ robot: robot.id, code: pairing.code });
        assert.strictEqual(r.status, 502, r.text);
        assert.strictEqual(r.json.code, 'bot.openre_refused');
        assert.strictEqual(m.openre.calls.length - callsBefore, 2, 'the call was tried exactly twice');
    });

    await m.close();
    done();
})();
