'use strict';
// AI on people's own machines is metered (ai-metrics.md): an `ai` command's ack is one ai.call-report@1 record for
// OpenVibe.AI, with the plugin's usage (Ollama's counts and decode time through openvibe-sdk/ai-meter's normalize),
// model server, model and the whole answer's latency; a nack is a failed call with its fault as the error class; a
// Bot without OV_AI_INTERNAL_URL sends nothing at all.
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/app');

/** OpenVibe.AI's meter stand-in: records every POST /api/v1/usage/calls and answers 202. */
async function startAi() {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (d) => chunks.push(d));
        req.on('end', () => {
            let body = null;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
            requests.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
            res.writeHead(202, { 'content-type': 'application/json' });
            res.end('{}');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

(async () => {
    const ai = await startAi();
    let t = null;
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(30); } return null; };

    /**
     * A Network-paired machine whose OpenVibe Link ai plugin answers `ai` commands with `answer(m, c)`; every other
     * kind is refused. Returns its device id, and `setAnswer` swaps the plugin's reply between checks.
     */
    async function machine(owner) {
        const principal = t.network.addNode({ owner: owner.subject, ref: `worker:${owner.subject}`, name: 'ai-pc' });
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
        const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
        const config = await c.waitFor((m) => m.type === 'config');
        const box = { answer: null };
        c.send(frame('status', { capabilities: { ai: { ai: { models: ['llama3.1:8b'], ready: true, max_tokens: 2048 } } }, drivers: [], faults: [] }));
        c.send(frame('telemetry', { sensors: {} }));
        c.ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.type !== 'command') return;
            if (m.kind === 'ai' && box.answer) box.answer(m, c, frame);
            else c.send(frame('nack', { id: m.id, fault_code: 'unsupported', message: 'not this plugin' }));
        });
        const beat = setInterval(() => { try { c.send(frame('heartbeat', { t: Date.now() })); } catch { /* closed */ } }, Math.max(100, Math.floor(config.heartbeat_ms / 2)));
        c.ws.on('close', () => clearInterval(beat));
        await poll(() => t.hub.computerOf(deviceId) !== null);
        return { c, deviceId, setAnswer: (fn) => { box.answer = fn; } };
    }

    try {
        t = await boot({ env: { OV_AI_INTERNAL_URL: ai.url } });
        assert.strictEqual(t.app.locals.meter.enabled, true, 'the meter is on with OV_AI_INTERNAL_URL');
        const alex = t.network.newUser('alex');
        const gpu = await machine(alex);
        const command = (id, value) => t.call('POST', `/api/v1/machines/${gpu.deviceId}/commands`, { user: alex, body: { id, kind: 'ai', value } });
        const ask = (id) => command(id, { model: 'llama3.1:8b', messages: [{ role: 'user', content: 'What is a mutex?' }] });

        await check('an ack with Ollama usage records one local call with tokens and tokens per second', async () => {
            gpu.setAnswer((m, c, send) => c.send(send('ack', {
                id: m.id,
                data: {
                    model: 'llama3.1:8b', server: 'ollama', ms: 9600, finish_reason: 'stop',
                    message: { role: 'assistant', content: 'A lock one thread holds at a time.' },
                    usage: { prompt_eval_count: 300, eval_count: 120, eval_duration: 9.6e9 },
                },
            })));
            const r = await ask('cmd_ollama_1');
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json.result, 'ack');
            await t.app.locals.meter.flush();
            const sent = ai.requests.at(-1);
            assert.strictEqual(sent.url, '/api/v1/usage/calls');
            assert.match(sent.auth, /^Bearer /, 'a minted service token');
            const token = t.network.tokenCalls.find((x) => x.audience === 'openvibe.ai');
            assert.deepStrictEqual([token && token.scope, token && token.client_id], ['ai.usage.report', 'bot'], 'Bot mints audience openvibe.ai for ai.usage.report');
            const call = sent.body.calls[0];
            assert.deepStrictEqual([call.system, call.run_id, call.operation, call.place, call.outcome],
                ['node', 'cmd_ollama_1', 'chat', 'machine', 'succeeded']);
            assert.deepStrictEqual([call.provider, call.model], ['ollama', 'llama3.1:8b']);
            assert.deepStrictEqual([call.input, call.output, call.reasoning, call.cache_read], [300, 120, 0, 0]);
            assert.strictEqual(call.tps, 12.5, '120 tokens over Ollama’s 9.6 s decode');
            assert.ok(call.latency_ms >= 0 && Number.isFinite(call.ttft_ms) === false, 'the whole answer’s latency, no streamed first token');
            assert.strictEqual(call.streamed, false);
            assert.ok(call.at && !Number.isNaN(Date.parse(call.at)), 'an ISO time');
        });

        await check('a community/ model records the bare model and place community', async () => {
            gpu.setAnswer((m, c, send) => c.send(send('ack', {
                id: m.id, data: { model: 'llama3.1:8b', server: 'lmstudio', message: { role: 'assistant', content: 'hi' }, usage: { prompt_tokens: 10, completion_tokens: 20 } },
            })));
            const r = await command('cmd_community_1', { model: 'community/llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] });
            assert.strictEqual(r.json.result, 'ack', r.text);
            await t.app.locals.meter.flush();
            const call = ai.requests.at(-1).body.calls[0];
            assert.deepStrictEqual([call.model, call.provider, call.place, call.input, call.output], ['llama3.1:8b', 'lmstudio', 'community', 10, 20]);
        });

        await check('a nack records a failed call with its fault as the error class', async () => {
            gpu.setAnswer((m, c, send) => c.send(send('nack', { id: m.id, fault_code: 'not_ready', message: 'the model is answering another request on this machine: try again in a moment' })));
            const r = await ask('cmd_nack_1');
            assert.strictEqual(r.json.result, 'nack');
            assert.match(r.json.reason, /another request/);
            await t.app.locals.meter.flush();
            const call = ai.requests.at(-1).body.calls[0];
            assert.deepStrictEqual([call.run_id, call.outcome, call.error_class, call.place], ['cmd_nack_1', 'failed', 'not_ready', 'machine']);
            assert.deepStrictEqual([call.input, call.output], [0, 0], 'no usage: zero tokens, never null');
        });

        await check('a command OpenVibe.AI sends is AI\'s run: AI records it, Bot never reports it again', async () => {
            const on = await t.call('POST', `/api/v1/machines/${gpu.deviceId}/ai-models`, { user: alex, body: { on: true } });
            assert.strictEqual(on.status, 200, on.text);
            gpu.setAnswer((m, c, send) => c.send(send('ack', {
                id: m.id, data: { model: 'llama3.1:8b', server: 'ollama', message: { role: 'assistant', content: 'hi' }, usage: { prompt_eval_count: 3, eval_count: 2, eval_duration: 1e9 } },
            })));
            const before = ai.requests.length;
            const asAi = { token: t.network.signService({ sub: 'svc:ai', cap: ['bot.machine.ai'] }), headers: { 'X-OV-Subject': alex.subject } };
            const r = await t.call('POST', `/api/v1/machines/${gpu.deviceId}/commands`, { ...asAi, body: { id: 'cmd_from_ai_1', kind: 'ai', value: { model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] } } });
            assert.strictEqual(r.json.result, 'ack', r.text);
            await t.app.locals.meter.flush();
            assert.strictEqual(ai.requests.length, before, 'no report: AI publishes its own ai.call.recorded@1 for this run');
        });

        gpu.c.close();
        await t.close();
        t = null;

        await check('without OV_AI_INTERNAL_URL the meter is off and an ai answer sends nothing', async () => {
            const before = ai.requests.length;
            t = await boot();
            assert.strictEqual(t.app.locals.meter.enabled, false, 'no AI URL, no meter');
            const alex = t.network.newUser('alex');
            const gpu = await machine(alex);
            gpu.setAnswer((m, c, send) => c.send(send('ack', {
                id: m.id, data: { model: 'llama3.1:8b', server: 'ollama', message: { role: 'assistant', content: 'hi' }, usage: { prompt_eval_count: 3, eval_count: 2, eval_duration: 1e9 } },
            })));
            const r = await t.call('POST', `/api/v1/machines/${gpu.deviceId}/commands`, {
                user: alex, body: { id: 'cmd_off_1', kind: 'ai', value: { model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] } },
            });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json.result, 'ack');
            await t.wait(150);
            assert.strictEqual(ai.requests.length, before, 'nothing reached AI');
            assert.strictEqual(t.app.locals.meter.stats().queued, 0);
            gpu.c.close();
        });
    } finally {
        if (t) await t.close().catch(() => {});
        await ai.close();
        done();
    }
})().catch((e) => { console.error(e); process.exit(1); });
