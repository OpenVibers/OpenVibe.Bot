'use strict';
// Streaming and recording toggles (plan T15 row S). The robot's OpenRe stream is the single source of truth:
// `media` is its recording_mode ('vod' records live sessions to OpenVibe.Media, 'none' does not) and `live`
// its mirror_to_live (the owner showing sessions on their OpenVibe.Live channel); both off by default. Bot
// stores no copy. Reading is a member read; changing is the owner's alone (`manage`, not `control`), and each
// real change is audited once (idempotent repeats are not).
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const operator = t.network.newUser('operator');
    const viewer = t.network.newUser('viewer');
    const stranger = t.network.newUser('stranger');

    const robotRow = (id) => t.db.maybe('SELECT * FROM robots WHERE id = $1', [id]);
    async function pairedRobot(owner = alex) {
        const { robot, pairing } = await t.robot(owner);
        const paired = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
        assert.strictEqual(paired.status, 201, paired.text);
        return { robot, paired: paired.json, streamId: (await robotRow(robot.id)).openre_stream_id };
    }
    const getStreaming = (robot, user = alex) => t.call('GET', `/api/v1/robots/${robot.id}/streaming`, { user });
    const postStreaming = (robot, body, user = alex) => t.call('POST', `/api/v1/robots/${robot.id}/streaming`, { user, body });
    const patches = () => t.openre.calls.filter((c) => c.method === 'PATCH');
    const auditOf = async (robot, kind) => (await t.domain.audit.list(robot.id)).filter((r) => r.kind === kind);

    await check('a newly paired robot streams off by default, read from OpenRe', async () => {
        const { robot, streamId } = await pairedRobot();
        assert.ok(streamId, 'pairing created the OpenRe stream');
        const st = t.openre.streams.get(streamId);
        assert.strictEqual(st.recording_mode, 'none', 'created with recording off');
        assert.strictEqual(st.mirror_to_live, false, 'created without mirroring');
        const r = await getStreaming(robot);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.available, true);
        assert.deepStrictEqual(r.json.media, { on: false });
        assert.strictEqual(r.json.live.on, false);
        assert.strictEqual(r.json.live.effective, 'when your Live channel plays OpenRe streams');
        assert.strictEqual(r.json.stream_id, streamId);
    });

    await check('the owner turns media on and off: OpenRe is PATCHed recording_mode vod/none', async () => {
        const { robot, streamId } = await pairedRobot();
        const on = await postStreaming(robot, { to: 'media', on: true });
        assert.strictEqual(on.status, 200, on.text);
        assert.strictEqual(on.json.media.on, true);
        const call = patches().at(-1);
        assert.strictEqual(call.path, `/api/v1/streams/${streamId}`);
        assert.deepStrictEqual(call.body, { recording_mode: 'vod' });
        assert.strictEqual(call.subject, alex.subject, 'OpenRe is asked for the robot\'s owner');
        assert.strictEqual(t.openre.streams.get(streamId).recording_mode, 'vod');
        assert.strictEqual((await getStreaming(robot)).json.media.on, true);
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}/audit`, { user: alex })).json.audit.find((a) => a.kind === 'streaming.media').value.on, true);

        const off = await postStreaming(robot, { to: 'media', on: false });
        assert.strictEqual(off.status, 200, off.text);
        assert.strictEqual(off.json.media.on, false);
        assert.deepStrictEqual(patches().at(-1).body, { recording_mode: 'none' });
        assert.strictEqual(t.openre.streams.get(streamId).recording_mode, 'none');
        assert.strictEqual((await getStreaming(robot)).json.media.on, false);
    });

    await check('the owner turns live on and off: OpenRe is PATCHed mirror_to_live', async () => {
        const { robot, streamId } = await pairedRobot();
        const on = await postStreaming(robot, { to: 'live', on: true });
        assert.strictEqual(on.status, 200, on.text);
        assert.strictEqual(on.json.live.on, true);
        assert.deepStrictEqual(patches().at(-1).body, { mirror_to_live: true });
        assert.strictEqual(t.openre.streams.get(streamId).mirror_to_live, true);

        const off = await postStreaming(robot, { to: 'live', on: false });
        assert.strictEqual(off.status, 200, off.text);
        assert.strictEqual(off.json.live.on, false);
        assert.deepStrictEqual(patches().at(-1).body, { mirror_to_live: false });
        assert.strictEqual(t.openre.streams.get(streamId).mirror_to_live, false);
    });

    await check('only the owner toggles: an operator and a viewer get 403; a member may read', async () => {
        const { robot, streamId } = await pairedRobot();
        await t.call('POST', `/api/v1/robots/${robot.id}/operators`, { user: alex, body: { subject: operator.subject, role: 'operator' } });
        await t.call('POST', `/api/v1/robots/${robot.id}/operators`, { user: alex, body: { subject: viewer.subject, role: 'viewer' } });
        const before = patches().length;
        assert.strictEqual((await postStreaming(robot, { to: 'media', on: true }, operator)).status, 403);
        assert.strictEqual((await postStreaming(robot, { to: 'live', on: true }, viewer)).status, 403);
        assert.strictEqual((await postStreaming(robot, { to: 'media', on: true }, stranger)).status, 403);
        assert.strictEqual(patches().length, before, 'a refused toggle never reaches OpenRe');
        assert.strictEqual(t.openre.streams.get(streamId).recording_mode, 'none');
        assert.strictEqual((await getStreaming(robot, operator)).status, 200);
        assert.strictEqual((await getStreaming(robot, viewer)).status, 200);
        assert.strictEqual((await getStreaming(robot, stranger)).status, 403);
    });

    await check('a bad toggle is 422 bot.invalid_streaming and nothing is PATCHed', async () => {
        const { robot } = await pairedRobot();
        const before = patches().length;
        for (const body of [{ to: 'openre', on: true }, { to: 'media', on: 'yes' }, { to: 'media' }, { to: 'media', on: 1 }, {}]) {
            const r = await postStreaming(robot, body);
            assert.strictEqual(r.status, 422, `${JSON.stringify(body)}: ${r.text}`);
            assert.strictEqual(r.json.code, 'bot.invalid_streaming');
        }
        assert.strictEqual(patches().length, before, 'no PATCH was sent');
    });

    await check('an unpaired robot has nothing to read and the write refuses bot.not_paired', async () => {
        const { robot } = await t.robot(alex);
        const got = await getStreaming(robot);
        assert.strictEqual(got.status, 200, got.text);
        assert.strictEqual(got.json.available, false);
        assert.strictEqual(got.json.reason, 'not_paired');
        assert.strictEqual(got.json.stream_id, null);
        assert.strictEqual(got.json.media.on, false);
        const post = await postStreaming(robot, { to: 'media', on: true });
        assert.strictEqual(post.status, 409, post.text);
        assert.strictEqual(post.json.code, 'bot.not_paired');
    });

    await check('an OpenRe 404 reads as stream_missing and the write refuses bot.not_paired', async () => {
        const { robot, streamId } = await pairedRobot();
        t.openre.streams.delete(streamId);
        const got = await getStreaming(robot);
        assert.strictEqual(got.status, 200, got.text);
        assert.strictEqual(got.json.available, false);
        assert.strictEqual(got.json.reason, 'stream_missing');
        assert.strictEqual(got.json.stream_id, streamId, 'the stored id is still reported');
        const post = await postStreaming(robot, { to: 'live', on: true });
        assert.strictEqual(post.status, 409, post.text);
        assert.strictEqual(post.json.code, 'bot.not_paired');
    });

    await check('setting the value it already has answers 200 and writes no second audit row', async () => {
        const { robot } = await pairedRobot();
        assert.deepStrictEqual(await auditOf(robot, 'streaming.media'), []);
        const first = await postStreaming(robot, { to: 'media', on: true });
        assert.strictEqual(first.status, 200, first.text);
        assert.strictEqual(first.json.media.on, true);
        const rows = await auditOf(robot, 'streaming.media');
        assert.strictEqual(rows.length, 1, 'one audit row for the change');
        assert.strictEqual(rows[0].operator_subject, alex.subject);
        assert.strictEqual(rows[0].operator_kind, 'user');
        assert.strictEqual(rows[0].role, 'owner');
        assert.deepStrictEqual(rows[0].value, { on: true });
        assert.strictEqual(rows[0].result, 'ack');

        const before = patches().length;
        const again = await postStreaming(robot, { to: 'media', on: true });
        assert.strictEqual(again.status, 200, again.text);
        assert.strictEqual(again.json.media.on, true);
        assert.strictEqual(patches().length, before, 'no second PATCH');
        assert.strictEqual((await auditOf(robot, 'streaming.media')).length, 1, 'no second audit row');

        const off = await postStreaming(robot, { to: 'media', on: false });
        assert.strictEqual(off.status, 200, off.text);
        assert.strictEqual((await auditOf(robot, 'streaming.media')).length, 2, 'a real change audits again');
        assert.deepStrictEqual((await auditOf(robot, 'streaming.live')), [], 'live was never touched');
    });


    // ── BOT_OPENRE_URL / BOT_OPENRE_TOKEN unset: no stream to read or set ─────────────────────────

    // The owner's panel carries the same switches as a plain form (works without JavaScript).
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const page = (path, user) => fetch(t.base + path, { redirect: 'manual', headers: cookie(user) });
    const form = (path, user, body) => fetch(t.base + path, {
        method: 'POST', redirect: 'manual', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...cookie(user) },
    });

    await check('the owner panel shows both switches off and the form sets them on OpenRe', async () => {
        const { robot, streamId } = await pairedRobot();
        let html = await (await page(`/panel/${robot.id}`, alex)).text();
        assert.match(html, new RegExp(`action="/robots/${robot.id}/streaming"`));
        assert.match(html, /Record to OpenVibe\.Media/);
        assert.match(html, /Show on my OpenVibe\.Live channel/);
        assert.doesNotMatch(html, /name="(media|live)" value="on" checked/, 'both off by default');
        const saved = await form(`/robots/${robot.id}/streaming`, alex, 'media_was=off&media=off&media=on&live_was=off&live=off');
        assert.strictEqual(saved.status, 303);
        assert.strictEqual(saved.headers.get('location'), `/panel/${robot.id}`);
        assert.strictEqual(t.openre.streams.get(streamId).recording_mode, 'vod');
        assert.strictEqual(t.openre.streams.get(streamId).mirror_to_live, false);
        html = await (await page(`/panel/${robot.id}`, alex)).text();
        assert.match(html, /name="media" value="on" checked/);
        assert.doesNotMatch(html, /name="live" value="on" checked/);
        assert.strictEqual((await auditOf(robot, 'streaming.live')).length, 0, 'an unchanged switch writes nothing');
        const bad = await form(`/robots/${robot.id}/streaming`, alex, 'media=maybe&live=off');
        assert.strictEqual(bad.status, 422);
        assert.match(html, /name="media_was" value="on"/, 'the page carries what each switch was drawn with');
    });

    await check('a stale tab does not revert a switch changed elsewhere', async () => {
        const erin = t.network.newUser('erin');
        const { robot, streamId } = await pairedRobot(erin);
        // Drawn with both off; meanwhile live was turned on elsewhere; the stale form only turns media on.
        t.openre.streams.get(streamId).mirror_to_live = true;
        const r = await form(`/robots/${robot.id}/streaming`, erin, 'media_was=off&media=off&media=on&live_was=off&live=off');
        assert.strictEqual(r.status, 303);
        assert.strictEqual(t.openre.streams.get(streamId).recording_mode, 'vod');
        assert.strictEqual(t.openre.streams.get(streamId).mirror_to_live, true, 'the untouched live switch is not reverted');
    });

    await check('only the owner sees and posts the streaming form', async () => {
        const { robot } = await pairedRobot();
        await t.call('POST', `/api/v1/robots/${robot.id}/operators`, { user: alex, body: { subject: operator.subject, role: 'operator' } });
        const html = await (await page(`/panel/${robot.id}`, operator)).text();
        assert.doesNotMatch(html, /data-streaming-form/, 'an operator sees no streaming switches');
        assert.strictEqual((await form(`/robots/${robot.id}/streaming`, operator, 'media=on&live=on')).status, 403);
        assert.strictEqual((await form(`/robots/${robot.id}/streaming`, stranger, 'media=on&live=on')).status, 403);
    });

    await check('an unpaired robot greys the switches out and says to pair a device', async () => {
        const { robot } = await t.robot(alex, { name: 'No device yet' });
        const html = await (await page(`/panel/${robot.id}`, alex)).text();
        assert.match(html, /Pair a device first/);
        assert.match(html, new RegExp(`href="/pair/${robot.id}"`));
        assert.match(html, /name="media" value="on" disabled/);
    });

    await check('an OpenRe that does not answer leaves the panel up with the switches greyed out', async () => {
        const dana = t.network.newUser('dana');   // a fresh owner: alex has used up the robot.manage minute by now
        const { robot } = await pairedRobot(dana);
        const real = t.domain.streaming.get;
        t.domain.streaming.get = async () => { throw Object.assign(new Error('down'), { status: 503 }); };
        try {
            const r = await page(`/panel/${robot.id}`, dana);
            assert.strictEqual(r.status, 200);
            assert.match(await r.text(), /OpenRe did not answer just now/);
        } finally { t.domain.streaming.get = real; }
    });
    await t.close();
    const u = await boot({ openre: false });
    const sam = u.network.newUser('sam');
    await check('without OpenRe configured streaming reads not_configured and the write is 409', async () => {
        const { robot, pairing } = await u.robot(sam);
        const paired = await u.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
        assert.strictEqual(paired.status, 201, paired.text);
        const got = await u.call('GET', `/api/v1/robots/${robot.id}/streaming`, { user: sam });
        assert.strictEqual(got.status, 200, got.text);
        assert.strictEqual(got.json.available, false);
        assert.strictEqual(got.json.reason, 'not_configured');
        const post = await u.call('POST', `/api/v1/robots/${robot.id}/streaming`, { user: sam, body: { to: 'live', on: true } });
        assert.strictEqual(post.status, 409, post.text);
        assert.strictEqual(post.json.code, 'bot.openre_not_configured');
    });
    await u.close();
    done();
})();
