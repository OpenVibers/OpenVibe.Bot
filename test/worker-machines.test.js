'use strict';
// A person's own machine that runs their jobs (plan T14/T16, contracts 0.161.0): a Network pairing with ref
// `worker:<owner>` binds a machine that serves no robot and keeps its owner; Bot reports every machine with a job
// worker to Network as a user-owned offer naming its owner (up while connected, down once it goes); a job reaches a
// machine only for its owner; /machines lists the person's machines, adds one with a one-time `--worker` command and
// removes one.
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const reports = [];
    const reporter = { report: async (offers) => { reports.push(offers); return { source: 'bot', offers: offers.length, marked_down: 0 }; } };
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0' }, appOpts: { offerReporter: reporter } });
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const { dispatch } = require('../server/jobs/dispatch');
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(50); } return null; };
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const form = (p, user, headers = {}) => fetch(t.base + p, { method: 'POST', redirect: 'manual', body: '', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(user ? cookie(user) : {}), ...headers } });
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const offers = t.app.locals.offers;

    /** A Network-paired machine for `ref`, connected, advertising `classes` (none: no job worker). */
    async function machine(owner, ref, classes = ['code']) {
        const principal = t.network.addNode({ owner: owner.subject, ref, name: 'desk-pc' });
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
        const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
        if (classes.length) {
            c.send(frame('status', { capabilities: { worker: { capabilities: classes.map((x) => `worker:${x}`), runtime_classes: classes } } }));
            await poll(async () => { const d = await t.db.maybe('SELECT capabilities FROM devices WHERE id = $1', [deviceId]); return d && d.capabilities.worker; });
        }
        return { principal, c, deviceId };
    }

    let mine;
    await check('a worker pairing binds a machine with no robot, owned by whoever paired it', async () => {
        mine = await machine(alex, `worker:${alex.subject}`);
        const row = await t.db.maybe('SELECT * FROM devices WHERE id = $1', [mine.deviceId]);
        assert.deepStrictEqual([row.robot_ids, row.owner_subject, row.kind], [[], alex.subject, 'server']);
        assert.strictEqual(await t.domain.devices.ownerOf(row), alex.subject);
        // Someone else's worker ref with this owner is refused: the ref must name the pairing's own owner.
        const stray = t.network.addNode({ owner: alex.subject, ref: `worker:${bob.subject}` });
        const bound = await t.call('POST', '/api/v1/devices/bind', { token: t.network.signNode(stray), body: {} });
        assert.strictEqual(bound.status, 403, bound.text);
        assert.strictEqual(bound.json.code, 'bot.node_not_bound');
    });

    await check('its worker offer is user-owned and names its owner: up while connected, down once it goes', async () => {
        const built = await offers.build();
        const offer = built.find((o) => o.node_id === mine.deviceId);
        assert.ok(offer, JSON.stringify(built));
        assert.deepStrictEqual([offer.kind, offer.trust, offer.owner, offer.capabilities, offer.health.status],
            ['node', 'user-owned', alex.subject, ['worker:code'], 'up']);
        // A robot's machine with a job worker is its robot owner's; a machine with no worker offers nothing.
        const { robot } = await t.robot(bob);
        const robots = await machine(bob, robot.id, ['function']);
        const quiet = await machine(bob, `worker:${bob.subject}`, []);
        const again = await offers.build();
        assert.strictEqual(again.find((o) => o.node_id === robots.deviceId).owner, bob.subject);
        assert.strictEqual(again.find((o) => o.node_id === quiet.deviceId), undefined);
        quiet.c.close();
        robots.c.close();
        // Reported whole, as Network's resource registry takes it.
        await offers.publish();
        assert.deepStrictEqual(reports.at(-1).map((o) => o.offer_id).sort(), again.map((o) => o.offer_id).sort());
    });

    await check('a machine runs only its owner’s jobs', async () => {
        const job = (over = {}) => ({ id: `job_${ids.ulid()}`, class: 'code', artifact: { name: 'openvibe-codes', version: '0.3.0' }, args: {}, ttl_ms: 60000, limits: { wall_ms: 30000, cpu_ms: 30000, mem_bytes: 268435456 }, ...over });
        const project = `prj_${ids.ulid()}`;
        const send = (subject) => dispatch(t.db, mine.deviceId, job(), { link: t.hub, project, subject });
        const ok = await send(`user:${alex.subject}`);
        assert.strictEqual(ok.sent, true);
        for (const subject of [`user:${bob.subject}`, null, 'service:watch', alex.subject]) {
            await assert.rejects(send(subject), (e) => e.status === 403 && e.code === 'bot.not_owner', String(subject));
        }
    });

    await check('/machines lists them, adds one with a one-time --worker command, and removes one', async () => {
        const anon = await fetch(`${t.base}/machines`, { redirect: 'manual' });
        assert.strictEqual(anon.status, 302, 'signed out: to the sign-in');
        const page = await (await fetch(`${t.base}/machines`, { headers: cookie(alex) })).text();
        assert.ok(page.includes('Your machines') && page.includes('desk-pc') && page.includes('Online') && page.includes('code jobs'), page);
        assert.ok(!page.includes(bob.subject));
        const added = await form('/machines', alex);
        assert.strictEqual(added.status, 201);
        const html = await added.text();
        const pairing = t.network.pairings.at(-1);
        assert.strictEqual(pairing.body.ref, `worker:${alex.subject}`);
        assert.ok(html.includes('--worker') && html.includes('--pairing pair_'), html);
        assert.strictEqual((await form('/machines', alex, { Origin: 'https://evil.test' })).status, 403, 'no cross-site post');
        assert.strictEqual((await form(`/machines/${mine.deviceId}/remove`, bob)).status, 404, 'not bob’s');
        const removed = await form(`/machines/${mine.deviceId}/remove`, alex);
        assert.strictEqual(removed.status, 303);
        assert.ok((await t.db.maybe('SELECT revoked_at FROM devices WHERE id = $1', [mine.deviceId])).revoked_at);
        assert.ok(t.network.revokes.includes(mine.principal));
        assert.strictEqual((await offers.build()).find((o) => o.node_id === mine.deviceId), undefined, 'a removed machine offers nothing');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
