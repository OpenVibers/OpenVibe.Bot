'use strict';
// "Offer to the network" (the design's community machines; plan E4): a Node ai plugin advertises its owner's models,
// hours, concurrency, price and audience in status.capabilities.ai.offer; Bot reports it as a user-owned provider offer
// whose detail.kind is `ai`, and AI may send a community run to that machine even with "Let my AI use this computer's
// models" off, because the offer is the opt-in. Without the offer the same run is refused. This is Bot's half: the
// report Network validates and the command gate AI places through.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const reports = [];
    const aiReports = [];
    const reporter = { report: async (offers) => { reports.push(offers); return { source: 'bot', offers: offers.length, marked_down: 0 }; } };
    const aiReporter = { report: async (offers) => { aiReports.push(offers); return { source: 'bot', offers: offers.length, marked_down: 0 }; } };
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0' }, appOpts: { offerReporter: reporter, aiOfferReporter: aiReporter } });
    const alex = t.network.newUser('alex');
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(30); } return null; };
    const seen = [];
    const OFFER = { enabled: true, models: ['llama3.1:8b'], hours: { start: '00:00', end: '23:59', tz: 'UTC' }, concurrency: 2,
        price: { in_per_million: 10, out_per_million: 30 }, audience: 'followers', group: null, open_now: true, ready: true };

    /** A Network-paired machine whose fake Node advertises an ai offer and answers one ai command. */
    async function machine() {
        const principal = t.network.addNode({ owner: alex.subject, ref: `worker:${alex.subject}`, name: 'gpu-box' });
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
        const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
        await c.waitFor((m) => m.type === 'config');
        c.send(frame('status', { capabilities: { ai: { ai: { models: ['llama3.1:8b'], ready: true, offer: OFFER } } }, drivers: [], faults: [] }));
        c.ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.type !== 'command') return;
            seen.push(m);
            if (m.kind === 'ai') c.send(frame('ack', { id: m.id, data: { model: m.value.model, message: { role: 'assistant', content: 'hello from the box' }, usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } } }));
            else c.send(frame('nack', { id: m.id, fault_code: 'not_allowed', message: 'no' }));
        });
        await poll(async () => { const d = await t.db.maybe('SELECT capabilities FROM devices WHERE id = $1', [deviceId]); return d && d.capabilities.ai && d.capabilities.ai.ai && d.capabilities.ai.ai.offer; });
        return { c, deviceId };
    }

    const cmd = (deviceId, body) => t.call('POST', `/api/v1/machines/${deviceId}/commands`, {
        body, sub: 'svc:ai', cap: ['bot.machine.ai'], headers: { 'X-OV-Subject': alex.subject },
    });

    let mine;
    await check('an ai offer becomes one user-owned provider offer with its settings', async () => {
        mine = await machine();
        const built = await t.app.locals.offers.buildAi();
        const offer = built.find((o) => o.offer_id === `ai:${mine.deviceId}`);
        assert.ok(offer, JSON.stringify(built));
        assert.deepStrictEqual([offer.machine_id, offer.owner, offer.models], [mine.deviceId, alex.subject, ['llama3.1:8b']]);
        assert.deepStrictEqual(offer.hours, { start: '00:00', end: '23:59', tz: 'UTC' });
        assert.deepStrictEqual([offer.concurrency, offer.price, offer.audience], [2, { in_per_million: 10, out_per_million: 30 }, 'followers']);
        assert.strictEqual(offer.ready, true);
        assert.strictEqual(offer.health.status, 'up');
        await t.app.locals.offers.publish();
        assert.ok(aiReports.at(-1).some((o) => o.offer_id === `ai:${mine.deviceId}`), 'the AI offers are reported to Network');
        assert.ok(reports.at(-1).some((o) => o.offer_id === `node:${mine.deviceId}`) === false, 'the worker report is separate');
        const page = await (await fetch(`${t.base}/machines`, { headers: { Cookie: `ov_token=${t.network.signUser(alex)}` } })).text();
        assert.ok(page.includes('A community machine sees the prompt'), 'the machine page says the privacy cost plainly');
        assert.ok(page.includes('Offering its models to the network'));
    });

    await check('AI sends a community run to the offered machine, even with the own-AI switch off', async () => {
        const r = await cmd(mine.deviceId, { id: 'c1', kind: 'ai', value: { model: 'community/llama3.1:8b', messages: [{ role: 'user', content: 'hello' }] } });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([r.json.result, r.json.data.message.content], ['ack', 'hello from the box']);
        assert.strictEqual(seen.at(-1).value.model, 'community/llama3.1:8b', 'the community/ prefix marks it; the local model name is stripped by the plugin');
        const row = await t.db.maybe('SELECT * FROM command_audit WHERE robot_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1', [mine.deviceId, 'ai']);
        assert.strictEqual(row.result, 'ack', 'and it is audited as any machine command is');
    });

    await check('a machine without the offer still refuses a community run, and the owner switch has not moved', async () => {
        const other = t.network.addNode({ owner: alex.subject, ref: `worker:${alex.subject}`, name: 'plain-box' });
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(other)}` } });
        const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
        await c.waitFor((m) => m.type === 'config');
        c.send(frame('status', { capabilities: { ai: { ai: { models: ['llama3.1:8b'], ready: true, offer: { enabled: false } } } }, drivers: [], faults: [] }));
        await poll(async () => { const d = await t.db.maybe('SELECT capabilities FROM devices WHERE id = $1', [deviceId]); return d && d.capabilities.ai; });
        const run = await cmd(deviceId, { kind: 'ai', value: { model: 'community/llama3.1:8b', messages: [{ role: 'user', content: 'x' }] } });
        assert.deepStrictEqual([run.status, run.json.code], [403, 'bot.agent_not_allowed']);
        assert.match(run.json.detail || '', /not offered/i);
        const own = await cmd(deviceId, { kind: 'ai', value: { model: 'llama3.1:8b', messages: [{ role: 'user', content: 'x' }] } });
        assert.deepStrictEqual([own.status, own.json.code], [403, 'bot.agent_not_allowed'], 'without either opt-in AI runs nothing there');
        assert.ok(!(await t.app.locals.offers.buildAi()).some((o) => o.offer_id === `ai:${deviceId}`), 'and no offer is reported');
    });

    await done(t);
})().catch((err) => { console.error(err); process.exit(1); });
