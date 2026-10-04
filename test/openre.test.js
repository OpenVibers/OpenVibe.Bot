'use strict';
// The publish key is an OpenRe ingest key (T15 R5): OpenRe's WHIP worker admits only keys in its own store, so
// pairing creates the robot's OpenRe stream (external ref bot:robot:<id>) and hands the device the key OpenRe
// returns; a re-pair and a credential rotation rotate that stream's key, a revocation rotates it with no grace
// and ends the session, a robot's removal also archives the stream when nothing is live. OpenRe refusing or
// not answering is a clean error with nothing half-written; Bot's token for OpenRe is never logged or
// answered; with BOT_OPENRE_* unset devices pair without video and Bot mints no key of its own.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { createOpenRe } = require('../server/openre/client');

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

    await check('the client is null without a URL and a token, and its errors never carry the token', async () => {
        assert.strictEqual(createOpenRe({ openre: { url: '', token: 'x', timeoutMs: 100 } }), null);
        assert.strictEqual(createOpenRe({ openre: { url: 'http://openre.test', token: '', timeoutMs: 100 } }), null);
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

    await check('pairing creates the robot\'s OpenRe stream and hands the device the ingest key OpenRe issued', async () => {
        const before = t.openre.calls.length;
        const { robot, paired } = await pairedRobot();
        const calls = callsSince(before);
        assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /api/v1/streams', 'POST /api/v1/streams']);
        assert.strictEqual(calls[0].query, `?external_ref=${encodeURIComponent(`bot:robot:${robot.id}`)}`);
        const create = calls[1];
        assert.strictEqual(create.subject, alex.subject, 'OpenRe is asked for the robot\'s owner');
        assert.strictEqual(create.authorization, `Bearer ${t.openre.token}`);
        assert.deepStrictEqual(create.body.protocols, ['webrtc']);
        assert.deepStrictEqual(create.body.external_refs, [{ service: 'bot', type: 'robot', id: robot.id, label: robot.name }]);
        assert.match(paired.publish_key, /^ork_[A-Za-z0-9_-]{43}$/);
        assert.ok(t.openre.admits(paired.publish_key), 'OpenRe admits the publish key');
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

    await check('a revocation OpenRe does not answer still revokes the device; the owner\'s retry revokes the key', async () => {
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

    await check('removing a robot whose stream is live ends the session and leaves the archive to OpenRe\'s refusal', async () => {
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
        await check(`OpenRe answering ${what} at pairing fails cleanly: the code stays usable and no device is made`, async () => {
            const { robot, pairing } = await t.robot(alex);
            const devicesBefore = Number((await t.db.maybe('SELECT count(*) AS n FROM devices')).n);
            t.openre.failNext(fault);
            const r = await redeem({ robot: robot.id, code: pairing.code });
            t.openre.failNext(null);
            assert.strictEqual(r.status, status, r.text);
            assert.strictEqual(r.json.code, code);
            if (fault === 403) assert.match(r.json.detail, /403 openre\.forbidden/, 'OpenRe\'s problem code is surfaced');
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

    await check('a credential rotation OpenRe refuses changes nothing: the old credential stays the current one', async () => {
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

    await check('Bot\'s OpenRe token is never logged and never in an answer', async () => {
        assert.ok(t.openre.calls.every((c) => c.authorization === `Bearer ${t.openre.token}` || c.authorization === null));
        assert.ok(!t.logs.join('\n').includes(t.openre.token), 'the token was logged');
        assert.ok(!responses.some((text) => text.includes(t.openre.token)), 'an answer carried the token');
    });

    await t.close();

    // ── BOT_OPENRE_URL / BOT_OPENRE_TOKEN unset ───────────────────────────────────────────────────
    const u = await boot({ openre: false, env: { BOT_WHIP_BASE: WHIP_BASE } });
    const sam = u.network.newUser('sam');
    await check('without OpenRe configured a device pairs, rotates and is removed with video reported not configured', async () => {
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
    done();
})();
