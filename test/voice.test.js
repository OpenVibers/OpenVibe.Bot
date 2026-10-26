'use strict';
// Vibe by voice on a person's own machine (server/voice.js, migration 0024, contracts 0.214.0 voice_ask / voice_answer):
// the owner turns voice on for a machine (with a call word), its config says so, a voice_ask is answered `working` at
// once and then with Vibe's answer, asked of OpenVibe.Chat as the owner (chat.vibe.ask, one source per machine, an
// idempotency key per question); voice off, a machine nobody owns or too many questions an hour are refused with why.
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const chatCalls = [];
    let chatAnswer = { state: 'answered', text: 'Clear skies after six.', url: 'https://openvibe.chat/vibe/v-0123456789ab', chat: 'v-0123456789ab' };
    const chat = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            chatCalls.push({ path: req.url, auth: req.headers.authorization || '', body: JSON.parse(body || '{}') });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(chatAnswer));
        });
    });
    await new Promise((r) => chat.listen(0, '127.0.0.1', r));
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0', BOT_CHAT_INTERNAL_URL: `http://127.0.0.1:${chat.address().port}`, BOT_VOICE_PER_HOUR: '3' } });
    const alex = t.network.newUser('alex');
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(30); } return null; };

    const principal = t.network.addNode({ owner: alex.subject, ref: `worker:${alex.subject}`, name: 'desk-pc' });
    const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
    const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
    const firstConfig = await c.waitFor((m) => m.type === 'config');
    c.send(frame('status', { capabilities: { voice: { engine: 'vosk', call_word: true }, computer: { screen: { level: 'trusted' } } }, drivers: [], faults: [] }));
    const beat = setInterval(() => { try { c.send(frame('heartbeat', { t: Date.now() })); } catch { /* closed */ } }, Math.max(100, Math.floor(firstConfig.heartbeat_ms / 2)));
    c.ws.on('close', () => clearInterval(beat));
    const answers = [];
    c.ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'voice_answer') answers.push(m); } catch { /* */ } });
    const ask = async (id, text = 'what is the weather like this evening') => {
        c.send(frame('voice_ask', { id, text, lang: 'en-US' }));
        return poll(() => { const got = answers.filter((a) => a.id === id); return got.some((a) => a.state !== 'working') ? got : null; });
    };

    try {
        await check('voice off: the machine is told nothing about listening, and a voice_ask is refused with where to turn it on', async () => {
            assert.strictEqual(firstConfig.voice, undefined, 'config says nothing of voice while it is off');
            const got = await ask('va-1');
            assert.deepStrictEqual(got.map((a) => a.state), ['refused']);
            assert.match(got[0].text, /Voice is off for this machine.*\/machines/);
            assert.strictEqual(chatCalls.length, 0, 'Chat was not asked');
        });

        await check('the owner turns it on with a call word; the machine\'s config says so; the machines page shows it', async () => {
            const r = await t.call('POST', `/api/v1/machines/${deviceId}/voice`, { user: alex, body: { on: true, call_word: 'Hey Desk' } });
            assert.deepStrictEqual([r.status, r.json.machine.voice], [200, { on: true, call_word: 'hey desk' }]);
            const cfg = await c.waitFor((m) => m.type === 'config' && m.voice === true);
            assert.strictEqual(cfg.call_word, 'hey desk');
            const bad = await t.call('POST', `/api/v1/machines/${deviceId}/voice`, { user: alex, body: { on: true, call_word: 'a' } });
            assert.deepStrictEqual([bad.status, bad.json.code], [422, 'bot.invalid_input']);
            const page = await fetch(`${t.base}/machines`, { headers: { Cookie: `ov_token=${t.network.signUser(alex)}` } }).then((x) => x.text());
            assert.match(page, /Voice: &quot;hey desk&quot;|Voice: "hey desk"/);
            assert.match(page, /Stop Vibe answering my voice here/);
        });

        await check('a voice_ask: working at once, then Vibe\'s answer, asked of Chat as the owner with one source per machine', async () => {
            const got = await ask('va-2');
            assert.deepStrictEqual(got.map((a) => a.state), ['working', 'answered']);
            assert.deepStrictEqual([got[1].text, got[1].url], ['Clear skies after six.', 'https://openvibe.chat/vibe/v-0123456789ab']);
            const call = chatCalls.at(-1);
            assert.strictEqual(call.path, '/internal/chat/vibe/ask');
            assert.match(call.auth, /^Bearer /);
            assert.deepStrictEqual(call.body, { subject: alex.subject, text: 'what is the weather like this evening', source: { kind: 'voice', id: deviceId, name: 'desk-pc' }, lang: 'en-US', idempotency_key: `${deviceId}:va-2` });
            const minted = t.network.tokenCalls.find((x) => x.audience === 'openvibe.chat');
            assert.ok(minted && /chat\.vibe\.ask/.test(minted.scope || ''), 'its own token for Chat, scoped to chat.vibe.ask');
        });

        await check('Chat refuses (the allowance spent): the machine hears why; too many questions an hour are refused here', async () => {
            chatAnswer = { state: 'refused', text: 'You have used today\'s free answers.', code: 'chat.vibe.allowance' };
            const got = await ask('va-3');
            assert.deepStrictEqual(got.map((a) => a.state), ['working', 'refused']);
            assert.match(got[1].text, /free answers/);
            // BOT_VOICE_PER_HOUR is 3 here and the asks with voice on so far are va-2 and va-3 (va-1 came while it was off).
            assert.deepStrictEqual((await ask('va-4')).map((a) => a.state), ['working', 'refused'], 'the third this hour is still asked');
            const before = chatCalls.length;
            const over = await ask('va-5');
            assert.deepStrictEqual(over.map((a) => a.state), ['refused'], 'the fourth this hour is refused without asking Chat');
            assert.match(over[0].text, /a lot of questions this hour/);
            assert.strictEqual(chatCalls.length, before);
        });

        await check('turned off again: the config stops it, and a bad frame is refused', async () => {
            const r = await t.call('POST', `/api/v1/machines/${deviceId}/voice`, { user: alex, body: { on: false } });
            assert.strictEqual(r.json.machine.voice.on, false);
            await c.waitFor((m) => m.type === 'config' && m.voice === undefined);
            c.send(frame('voice_ask', { id: 'bad id with spaces', text: 'x' }));
            const err = await c.waitFor((m) => m.type === 'error');
            assert.strictEqual(err.code, 'bot.bad_frame');
            const bob = t.network.newUser('bob');
            assert.strictEqual((await t.call('POST', `/api/v1/machines/${deviceId}/voice`, { user: bob, body: { on: true } })).status, 404, 'only its owner');
        });
    } finally {
        c.close();
        chat.close();
        await done(t);
    }
})().catch((e) => { console.error(e); process.exit(1); });
