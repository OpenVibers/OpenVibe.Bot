'use strict';
// Run accepts a job's args up to 512 KB (RUN_LIMITS_MAX_ARGS_BYTES) and the job frame may be 1 MiB (the Link's frame
// limit, platform.job@1), but Bot's /api/v1 took 64 KB bodies, so Run's hand-off of any job with larger args failed
// 413 request.too_large before reaching the machine (11-18: a 10 s live speech segment, ~470 KB as base64, for
// Parakeet on the shared node). POST /api/v1/jobs alone now takes a body up to the frame limit.
//   node test/run-jobs-large-args.test.js
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

const PROJECT = `prj_${ids.ulid()}`;

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const asRun = { sub: 'svc:run', cap: ['bot.job.dispatch'] };

    const { robot } = await t.robot(alex);
    const principal = t.network.addNode({ owner: alex.subject, ref: robot.id });
    const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
    const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
    await c.waitFor((m) => m.type === 'config');
    c.send(frame('status', { capabilities: { worker: { capabilities: ['worker:linux'], runtime_classes: ['linux'] } } }));
    await poll(async () => { const d = await t.db.maybe('SELECT capabilities FROM devices WHERE id = $1', [deviceId]); return d && d.capabilities.worker; });

    const job = (args) => ({
        id: `job_${ids.ulid()}`, class: 'linux', artifact: { name: 'openvibe-asr', version: '1.0.0' }, args,
        ttl_ms: 60000, limits: { wall_ms: 60000, cpu_ms: 240000, mem_bytes: 2147483648 },
    });

    await check('a job with args near Run\'s 512 KB cap reaches the Link whole', async () => {
        const audio = 'UklGR' + 'A'.repeat(470 * 1024);
        const j = job({ audio_b64: audio });
        const r = await t.call('POST', '/api/v1/jobs', { ...asRun, body: { node_id: deviceId, job: j, project_id: PROJECT, subject: `user:${alex.subject}` } });
        assert.strictEqual(r.status, 201, `${r.status} ${r.text.slice(0, 200)}`);
        const f = await c.waitFor((m) => m.type === 'job' && m.job.id === j.id);
        assert.strictEqual(f.job.args.audio_b64.length, audio.length, 'the args arrive intact');
    });

    await check('a body over the Link\'s 1 MiB frame is still refused as too large', async () => {
        const r = await t.call('POST', '/api/v1/jobs', { ...asRun, body: { node_id: deviceId, job: job({ blob: 'A'.repeat(1100 * 1024) }), project_id: PROJECT } });
        assert.strictEqual(r.status, 413, `${r.status} ${r.text.slice(0, 200)}`);
        assert.strictEqual(r.json && r.json.code, 'request.too_large');
    });

    await check('every other API route keeps its 64 KB body limit', async () => {
        const r = await t.call('POST', '/api/v1/pair', { body: { code: 'A'.repeat(100 * 1024) } });
        assert.strictEqual(r.status, 413, `${r.status} ${r.text.slice(0, 200)}`);
    });
    await done(t);
})().catch((e) => { console.error(e); process.exit(1); });

async function poll(fn, ms = 20000) {
    const until = Date.now() + ms;
    for (;;) {
        if (await fn()) return;
        if (Date.now() > until) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 25));
    }
}
