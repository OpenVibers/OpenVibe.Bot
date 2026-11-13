'use strict';
// A6 (plan 2026-11-13 Y.1): a skill job runs code inside the job's own directory, and the skill can read every
// file there. OpenVibe.Link v0.56.0 is the first Link whose job sandbox keeps the owner's sign-in files out of
// that directory; an older Link would put them where the skill reads them. Link has no auto-update, so the
// refusal happens where the machine's Link version is known: here, at dispatch, before the job is sent.
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

const PROJECT = `prj_${ids.ulid()}`;

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const SUBJECT = `user:${alex.subject}`;
    // Required after boot(): it reloads server/, and these must be the same modules the app runs.
    const { dispatch, linkCarriesGuarantee } = require('../server/jobs/dispatch');

    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const newJob = (over = {}) => ({
        id: `job_${ids.ulid()}`, class: 'function', artifact: { name: 'thumbnail', version: '1.2.0' }, args: { width: 320 },
        ttl_ms: 60000, limits: { wall_ms: 30000, cpu_ms: 30000, mem_bytes: 268435456 }, ...over,
    });
    const skillJob = (over = {}) => newJob({ artifact: { name: 'openvibe-skill-runner', version: '1.0.0' }, ...over });
    const row = (id) => t.db.maybe('SELECT * FROM run_jobs WHERE id = $1', [id]);
    const send = (deviceId, job) => dispatch(t.db, deviceId, job, { link: t.hub, project: PROJECT, subject: SUBJECT });

    /** A paired Link on the device socket, advertising the function class and reporting its own version. */
    async function node(agentVersion) {
        const { robot } = await t.robot(alex);
        const principal = t.network.addNode({ owner: alex.subject, ref: robot.id });
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
        const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
        await c.waitFor((m) => m.type === 'config');
        c.send(frame('status', {
            capabilities: { worker: { capabilities: ['worker:function'], runtime_classes: ['function'] } },
            agent_version: agentVersion,
        }));
        await poll(async () => {
            const d = await t.db.maybe('SELECT agent_version FROM devices WHERE id = $1', [deviceId]);
            return d && d.agent_version === agentVersion;
        });
        return { deviceId, c };
    }

    await check('a Link that cannot report its version does not carry the guarantee', () => {
        assert.strictEqual(linkCarriesGuarantee('0.55.9'), false);
        assert.strictEqual(linkCarriesGuarantee('0.56.0'), true);
        assert.strictEqual(linkCarriesGuarantee('v0.56.0'), true);
        assert.strictEqual(linkCarriesGuarantee('0.56.1'), true);
        assert.strictEqual(linkCarriesGuarantee('v0.59.0'), true);
        assert.strictEqual(linkCarriesGuarantee('1.0.0'), true);
        // A build with no readable version proves nothing, so it does not carry the guarantee.
        assert.strictEqual(linkCarriesGuarantee('dev'), false);
        assert.strictEqual(linkCarriesGuarantee(''), false);
        assert.strictEqual(linkCarriesGuarantee(null), false);
    });

    await check('a skill job is refused on a Link older than v0.56.0, with the words the person needs', async () => {
        const n = await node('v0.55.3');
        const job = skillJob();
        await assert.rejects(send(n.deviceId, job), (e) => {
            assert.strictEqual(e.code, 'bot.link_too_old');
            assert.strictEqual(e.status, 409);
            assert.strictEqual(e.detail, 'Update Link to run skills');
            return true;
        });
        assert.strictEqual(await row(job.id), null, 'the job is never stored and never sent');
        assert.ok(!n.c.messages.some((m) => m.type === 'job'), 'the Link is never asked to run it');
    });

    await check('a skill job is refused on a machine whose version was never read', async () => {
        const n = await node('');
        await assert.rejects(send(n.deviceId, skillJob()), (e) => e.code === 'bot.link_too_old');
    });

    await check('a Link with v0.56.0 or later runs the skill job', async () => {
        const n = await node('v0.56.0');
        const job = skillJob();
        const r = await send(n.deviceId, job);
        assert.strictEqual(r.sent, true);
        const f = await n.c.waitFor((m) => m.type === 'job' && m.job.id === job.id);
        assert.deepStrictEqual(f.job, job);
    });

    await check('an ordinary job on an old Link is not refused: only a skill job needs the sandbox', async () => {
        const n = await node('v0.40.0');
        const job = newJob();
        const r = await send(n.deviceId, job);
        assert.strictEqual(r.sent, true);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

async function poll(fn, ms = 20000) {
    const until = Date.now() + ms;
    for (;;) {
        if (await fn()) return;
        if (Date.now() > until) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 25));
    }
}
