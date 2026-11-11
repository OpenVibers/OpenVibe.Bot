'use strict';
// Machine access, stage 1 (Contracts 0.409.0): two paired machines relay frames only under Network's signed grant,
// the scope is checked on every frame, a computer frame is capped by the target's own level, a revoked grant closes
// the relay at once, and Network's agent.task reaches a machine whose answer goes back to Network. Each refusal is
// checked, and the grant-use audit is recorded with Network once per scope.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    // The sockets in this test send no heartbeats; keep a quiet machine online for the whole run.
    const t = await boot({ env: { BOT_OFFLINE_MISSES: '100000' } });
    const alex = t.network.newUser('alex'), sam = t.network.newUser('sam');
    const alexRobot = (await t.robot(alex)).robot;
    const samRobot = (await t.robot(sam)).robot;
    const a = t.network.addNode({ owner: alex.subject, ref: alexRobot.id, name: 'laptop' });
    const b = t.network.addNode({ owner: sam.subject, ref: samRobot.id, name: 'desktop' });
    const c = t.network.addNode({ owner: sam.subject, ref: samRobot.id, name: 'other' });
    const connect = async (principal) => {
        const ws = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
        await ws.waitFor((m) => m.type === 'config');
        return ws;
    };
    const ma = await connect(a), mb = await connect(b);
    const device = async (principal) => await t.db.maybe('SELECT * FROM devices WHERE node_principal = $1 AND revoked_at IS NULL', [principal]);
    // Frames are asynchronous: settle, then forget what the last check left so a wait can never read a stale frame.
    const drain = async (...clients) => { await t.wait(50); for (const c of clients) c.messages = []; };
    const nextError = async (client = ma) => {
        const e = await client.waitFor((m) => m.type === 'error');
        if (e) client.messages.splice(client.messages.indexOf(e), 1);
        return e;
    };
    const da = await device(a), db = await device(b);

    const open = async (from, to, scopes, source = ma, target = mb) => {
        const grantId = `grt_${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 14)}`;
        await drain(source, target);
        source.send({ type: 'relay.open', to, grant_token: t.network.signGrant({ from, to, scopes, grantId }) });
        const opened = await source.waitFor((m) => m.type === 'relay.opened');
        assert.ok(opened, 'relay opened on the asking machine');
        const targetOpened = await target.waitFor((m) => m.type === 'relay.opened' && m.relay === opened.relay);
        assert.ok(targetOpened, 'the target is told the same relay and the same token');
        assert.strictEqual(targetOpened.grant_token, opened.grant_token);
        return { relay: opened.relay, grantId };
    };

    await check('a grant relays a frame both ways, and the use is audited with Network once per scope', async () => {
        await drain(ma, mb);
        const { relay, grantId } = await open(a, b, ['screen', 'agent']);
        ma.send({ type: 'relay.frame', relay, scope: 'screen', body: { hello: 'screen' } });
        const atB = await mb.waitFor((m) => m.type === 'relay.frame');
        assert.strictEqual(atB.from, a);
        assert.deepStrictEqual(atB.body, { hello: 'screen' });
        mb.send({ type: 'relay.frame', relay, scope: 'screen', body: { answer: 1 } });
        const atA = await ma.waitFor((m) => m.type === 'relay.frame' && m.from === b);
        assert.deepStrictEqual(atA.body, { answer: 1 });
        await t.wait(120);
        const use = t.network.ledger.uses.find((u) => u.grant_id === grantId);
        assert.ok(use, 'Network was told the grant was used');
        assert.strictEqual(use.body.scope, 'screen');
        assert.strictEqual(use.body.from_principal, a);
        assert.strictEqual(use.body.to_principal, b);
        ma.send({ type: 'relay.close', relay });
        assert.strictEqual((await ma.waitFor((m) => m.type === 'relay.closed')).reason, 'closed');
        assert.strictEqual((await mb.waitFor((m) => m.type === 'relay.closed')).reason, 'closed');
    });

    await check('a scope outside the grant is refused and never delivered', async () => {
        await drain(ma, mb);
        const { relay } = await open(a, b, ['agent']);
        ma.send({ type: 'relay.frame', relay, scope: 'screen', body: { x: 1 } });
        const err = await nextError();
        assert.strictEqual(err.code, 'bot.relay_scope_denied');
        assert.ok(!mb.messages.some((m) => m.type === 'relay.frame' && m.body && m.body.x === 1));
        ma.send({ type: 'relay.close', relay });
        await ma.waitFor((m) => m.type === 'relay.closed');
    });

    await check('a token for another machine, a forged requester, an expired token and an unknown relay are refused', async () => {
        await drain(ma, mb);
        ma.send({ type: 'relay.open', to: b, grant_token: t.network.signGrant({ from: c, to: b, scopes: ['agent'] }) });
        assert.strictEqual((await nextError()).code, 'bot.relay_grant_denied');
        ma.send({ type: 'relay.open', to: b, grant_token: t.network.signGrant({ from: a, to: c, scopes: ['agent'] }) });
        assert.strictEqual((await nextError()).code, 'bot.relay_grant_denied');
        ma.send({ type: 'relay.open', to: b, grant_token: t.network.signGrant({ from: a, to: b, scopes: ['agent'], expSec: -1 }) });
        assert.strictEqual((await nextError()).code, 'bot.relay_grant_denied');
        ma.send({ type: 'relay.open', to: c, grant_token: t.network.signGrant({ from: a, to: c, scopes: ['agent'] }) });
        assert.strictEqual((await nextError()).code, 'bot.relay_target_offline');
        ma.send({ type: 'relay.frame', relay: 'rly_nope', scope: 'agent', body: {} });
        assert.strictEqual((await nextError()).code, 'bot.relay_unknown');
    });

    await check('a computer frame is capped by the receiving machine\'s own level', async () => {
        await drain(ma, mb);
        mb.send({ type: 'status', capabilities: { computer: { files: { level: 'ask' } } }, telemetry: { sensors: { computer_level: 'ask' } } });
        await t.wait(50);
        const { relay } = await open(a, b, ['computer']);
        ma.send({ type: 'relay.frame', relay, scope: 'computer', body: { level: 'trusted', action: 'fs' } });
        const capped = await nextError();
        assert.strictEqual(capped.code, 'bot.relay_computer_level');
        ma.send({ type: 'relay.frame', relay, scope: 'computer', body: { level: 'ask', action: 'fs' } });
        const frame = await mb.waitFor((m) => m.type === 'relay.frame' && m.scope === 'computer');
        assert.strictEqual(frame.body.level, 'ask');
        ma.send({ type: 'relay.close', relay });
        await ma.waitFor((m) => m.type === 'relay.closed');
    });

    await check('Network revoking the grant closes the relay at once and the id stops working', async () => {
        await drain(ma, mb);
        const { relay, grantId } = await open(a, b, ['agent']);
        assert.strictEqual(t.hub.revokeGrant(grantId), 1);
        assert.strictEqual((await ma.waitFor((m) => m.type === 'relay.closed')).reason, 'revoked');
        assert.strictEqual((await mb.waitFor((m) => m.type === 'relay.closed')).reason, 'revoked');
        ma.send({ type: 'relay.frame', relay, scope: 'agent', body: {} });
        assert.strictEqual((await nextError()).code, 'bot.relay_unknown');
    });

    await check('Network delivers an agent.task over HTTP; only the machine it reached may answer, and the answer reaches Network', async () => {
        await drain(ma, mb);
        const relayToken = t.network.signService({ sub: 'svc:network', cap: ['bot.machine.relay'] });
        const task = { id: `tsk_${'a'.repeat(24)}`, thread: `thr_${'b'.repeat(24)}`, from: `agt_${'C'.repeat(26)}`,
            to: `agt_${'D'.repeat(26)}`, on_behalf_of: sam.subject, message: { role: 'user', parts: [{ type: 'text', text: 'hello' }] } };
        const delivered = await t.call('POST', `/api/v1/machines/${db.id}/relay`, { token: relayToken,
            headers: { 'X-OV-Subject': sam.subject }, body: { type: 'agent.task', task } });
        assert.strictEqual(delivered.status, 201, delivered.text);
        const frame = await mb.waitFor((m) => m.type === 'agent.task');
        assert.strictEqual(frame.task.id, task.id);
        // The other machine may not answer a task it never received.
        ma.send({ type: 'agent.task_result', task_id: task.id, status: 'completed', result: { parts: [{ type: 'text', text: 'no' }] } });
        assert.strictEqual((await ma.waitFor((m) => m.type === 'error')).code, 'bot.agent_task_unknown');
        // A body over the text limit is refused before it leaves Bot (while the task is still open).
        mb.send({ type: 'agent.task_result', task_id: task.id, status: 'completed', result: { parts: [{ type: 'text', text: 'x'.repeat(8001) }] } });
        assert.strictEqual((await mb.waitFor((m) => m.type === 'error')).code, 'bot.bad_frame');
        mb.send({ type: 'agent.task_result', task_id: task.id, status: 'completed', result: { parts: [{ type: 'text', text: 'done' }] } });
        const ack = await mb.waitFor((m) => m.type === 'agent.task_result_ack');
        assert.strictEqual(ack.status, 'completed');
        await t.wait(120);
        const sent = t.network.ledger.results.find((r) => r.task_id === task.id);
        assert.ok(sent, 'Network received the answer');
        assert.strictEqual(sent.body.status, 'completed');
        assert.strictEqual(sent.body.result.parts[0].text, 'done');
    });

    await check('the relay route refuses another owner, a missing capability and a malformed task', async () => {
        await drain(ma, mb);
        const relayToken = t.network.signService({ sub: 'svc:network', cap: ['bot.machine.relay'] });
        const task = { id: `tsk_${'e'.repeat(24)}`, thread: `thr_${'f'.repeat(24)}`, from: `agt_${'G'.repeat(26)}`,
            to: `agt_${'H'.repeat(26)}`, on_behalf_of: alex.subject, message: { parts: [{ type: 'text', text: 'x' }] } };
        const wrong = await t.call('POST', `/api/v1/machines/${db.id}/relay`, { token: relayToken,
            headers: { 'X-OV-Subject': alex.subject }, body: { type: 'agent.task', task } });
        assert.strictEqual(wrong.status, 404, wrong.text);
        const noCap = await t.call('POST', `/api/v1/machines/${db.id}/relay`, { token: t.network.signService({ sub: 'svc:network', cap: ['bot.machine.manage'] }),
            headers: { 'X-OV-Subject': sam.subject }, body: { type: 'agent.task', task } });
        assert.strictEqual(noCap.status, 403, noCap.text);
        const bad = await t.call('POST', `/api/v1/machines/${db.id}/relay`, { token: relayToken,
            headers: { 'X-OV-Subject': sam.subject }, body: { type: 'agent.task', task: { ...task, id: 'nope' } } });
        assert.strictEqual(bad.status, 409, bad.text);
        const notTask = await t.call('POST', `/api/v1/machines/${db.id}/relay`, { token: relayToken,
            headers: { 'X-OV-Subject': sam.subject }, body: { type: 'computer.command' } });
        assert.strictEqual(notTask.status, 422, notTask.text);
    });

    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
