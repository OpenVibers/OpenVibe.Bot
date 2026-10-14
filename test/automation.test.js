'use strict';
// Routines and webhooks (plan T15 "schedules and automations … webhooks"): an owner's steps run through the same gate
// as a person's commands (on demand, on a schedule, when the robot comes online), stop at anything the robot refuses,
// and a robot's events reach the owner's https endpoint signed like OpenVibe.Events deliveries, with retries.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { parseSteps, parseTrigger, nextRun } = require('../server/routines');
const { createWebhooks, BACKOFF_S } = require('../server/webhooks');
const { verifyDeliveryV2 } = require('openvibe-sdk/events');
const { loadProfiles } = require('../server/profiles');
const world = require('../public/sim-world');

(async () => {
    const profiles = loadProfiles();

    await check('steps parse against the robot\'s own profile, with the line that is wrong', () => {
        const sim = profiles.get('sim.rover');
        const { steps } = parseSteps('# patrol\nforward 2\nright 0.5 0.4\nheadlights #ff8800\nhorn C5 0.3\nwait 1\nback 1\nstop', sim);
        assert.deepStrictEqual(steps.map((s) => s.kind), ['drive', 'drive', 'actuator', 'actuator', 'wait', 'drive', 'drive']);
        assert.deepStrictEqual(steps[1].value, { steer: 0.4 });
        assert.deepStrictEqual(steps[2].value, { name: 'headlights', value: { r: 255, g: 136, b: 0 } });
        assert.deepStrictEqual(steps[3].value, { name: 'horn', value: { note: 'C5' } });
        const cozmo = profiles.get('cozmo');
        const c = parseSteps('say Hello there\nface happy\nhead 0.5', cozmo).steps;
        assert.deepStrictEqual(c.map((s) => s.kind), ['say', 'display', 'actuator']);
        for (const [bad, why] of [['say hi', /does not speak/], ['fly 3', /line 1 \("fly 3"\): "fly"/], ['forward 120', /seconds/], ['', /at least one step/], ['headlights red', /colour/]]) {
            assert.throws(() => parseSteps(bad, sim), (e) => e.status === 422 && why.test(e.detail), bad);
        }
        assert.throws(() => parseSteps(Array(12).fill('forward 60').join('\n'), sim), /at most 10 minutes/);
    });

    await check('triggers: every N minutes (at least 5), daily at a UTC time on chosen days, or each time it comes online', () => {
        assert.strictEqual(nextRun(parseTrigger({ type: 'schedule', every: 15 }), new Date('2026-10-14T10:00:00Z')).toISOString(), '2026-10-14T10:15:00.000Z');
        const wed = new Date('2026-10-14T10:00:00Z');   // a Wednesday
        assert.strictEqual(nextRun(parseTrigger({ type: 'schedule', at: '09:30', days: [1, 3] }), wed).toISOString(), '2026-10-19T09:30:00.000Z');
        assert.strictEqual(nextRun(parseTrigger({ type: 'schedule', at: '23:00' }), wed).toISOString(), '2026-10-14T23:00:00.000Z');
        assert.strictEqual(nextRun({ type: 'online' }, wed), null);
        assert.throws(() => parseTrigger({ type: 'schedule', every: 2 }), /at least 5/);
        assert.throws(() => parseTrigger({ type: 'schedule', at: '25:00' }), /09:30/);
        assert.throws(() => parseTrigger({ type: 'weekly' }), /manual, schedule or online/);
    });

    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0' } });
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const { routines } = t.app.locals;
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(50); } return null; };
    const { robot } = await t.robot(alex, { name: 'Patroller', profile_id: 'sim.rover' });
    assert.ok(await t.app.locals.sim.attach(robot.id));
    await poll(() => t.hub.isOnline(`dev_sim_${robot.id}`));
    const api = (method, path, user, body) => t.call(method, `/api/v1/robots/${robot.id}${path}`, { user, body });
    const routineOf = async (id) => (await api('GET', '/routines', alex)).json.routines.find((r) => r.id === id);

    await check('the owner\'s routine runs through the gate: the simulated rover drives, lights up, and it ends done', async () => {
        const made = await api('POST', '/routines', alex, { name: 'Patrol', steps: 'forward 0.8\nheadlights #ff0000\nwait 0.2\nstop' });
        assert.strictEqual(made.status, 201, made.text);
        assert.deepStrictEqual([made.json.routine.trigger, made.json.routine.steps.split('\n').length], [{ type: 'manual' }, 4]);
        const run = await api('POST', `/routines/${made.json.routine.id}/run`, alex);
        assert.strictEqual(run.status, 202, run.text);
        assert.ok(await poll(async () => (await routineOf(made.json.routine.id)).last_result === 'done'), 'it finished');
        // Telemetry is sampled twice a second: wait for the sample after the last step.
        const tel = await poll(() => { const x = t.hub.deviceState(`dev_sim_${robot.id}`).telemetry; return x && x.sim.headlights && x.sim.headlights.r === 255 && x.sim.pose.y > world.START.y + 0.1 ? x : null; });
        assert.ok(tel, 'the rover moved forward and its headlights are red');
        const audit = (await api('GET', '/audit', alex)).json.audit || [];
        assert.ok(audit.some((a) => a.kind === 'drive' && a.operator_subject === alex.subject && a.result === 'ack'), 'each step is on the record as the owner\'s');
    });

    await check('one routine at a time; removing a running routine stops it; the e-stop stops one with its reason', async () => {
        const long = (await api('POST', '/routines', alex, { name: 'Long', steps: 'forward 5' })).json.routine;
        assert.strictEqual((await api('POST', `/routines/${long.id}/run`, alex)).status, 202);
        assert.strictEqual((await api('POST', `/routines/${long.id}/run`, alex)).status, 409, 'already running');
        assert.strictEqual((await api('DELETE', `/routines/${long.id}`, alex)).status, 204);
        assert.ok(await poll(() => !routines.isRunning(robot.id)), 'it stopped');
        const again = (await api('POST', '/routines', alex, { name: 'Again', steps: 'forward 5' })).json.routine;
        await api('POST', `/routines/${again.id}/run`, alex);
        await t.wait(400);
        assert.strictEqual((await api('POST', '/estop', alex)).status, 200);
        const stopped = await poll(async () => { const r = await routineOf(again.id); return r.last_result.startsWith('stopped') ? r : null; });
        assert.ok(stopped, 'the e-stop stopped it');
        assert.match(stopped.last_result, /stopped: .*(e-stop|estop|latched)/i);
        assert.strictEqual((await api('POST', '/estop/clear', alex)).status, 200);
    });

    await check('a schedule runs when due and moves on; an "each time it comes online" routine runs on the robot\'s return', async () => {
        const s = (await api('POST', '/routines', alex, { name: 'Every 5', steps: 'headlights #00ff00', trigger: { type: 'schedule', every: 5 } })).json.routine;
        assert.ok(Date.parse(s.next_run_at) > Date.now() + 4 * 60000, 'first run in 5 minutes');
        await t.db.query("UPDATE robot_routines SET next_run_at = now() - interval '1 second' WHERE id = $1", [s.id]);
        assert.strictEqual(await routines.tick(), 1);
        assert.ok(await poll(async () => (await routineOf(s.id)).last_result === 'done'));
        assert.ok(Date.parse((await routineOf(s.id)).next_run_at) > Date.now() + 4 * 60000, 'the next run is 5 minutes on');
        assert.strictEqual(await routines.tick(), 0, 'nothing else is due');
        const on = (await api('POST', '/routines', alex, { name: 'Hello', steps: 'headlights #0000ff', trigger: { type: 'online' } })).json.routine;
        await routines.onOnline(robot.id);
        assert.ok(await poll(async () => (await routineOf(on.id)).last_result === 'done'));
        assert.ok(await poll(() => { const x = t.hub.deviceState(`dev_sim_${robot.id}`).telemetry; return x && x.sim.headlights && x.sim.headlights.b === 255; }), 'the online routine turned the lights blue');
    });

    await check('someone else\'s robot: no routines, no webhooks, read or write', async () => {
        assert.strictEqual((await api('GET', '/routines', bob)).status, 403);
        assert.strictEqual((await api('POST', '/routines', bob, { name: 'x', steps: 'forward 1' })).status, 403);
        assert.strictEqual((await api('POST', '/webhooks', bob, { url: 'https://hooks.example.com/x', events: ['bot.estop.set'] })).status, 403);
        const bad = await api('POST', '/routines', alex, { name: 'Bad', steps: 'say hello' });
        assert.deepStrictEqual([bad.status, bad.json.code], [422, 'bot.invalid_routine']);
    });

    let secret; let hookId;
    await check('webhooks: https and public only, at most five, the secret once', async () => {
        for (const url of ['http://hooks.example.com/x', 'https://localhost/x', 'https://10.1.2.3/x', 'https://user:pw@hooks.example.com/x']) {
            assert.strictEqual((await api('POST', '/webhooks', alex, { url, events: ['bot.estop.set'] })).status, 422, url);
        }
        assert.strictEqual((await api('POST', '/webhooks', alex, { url: 'https://hooks.example.com/x', events: ['bot.robot.exploded'] })).status, 422);
        const made = await api('POST', '/webhooks', alex, { url: 'https://hooks.example.com/robot', events: ['bot.estop.set', 'bot.estop.cleared'] });
        assert.strictEqual(made.status, 201, made.text);
        secret = made.json.secret;
        hookId = made.json.webhook.id;
        assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
        const list = await api('GET', '/webhooks', alex);
        assert.ok(!list.text.includes('whsec_'), 'a read never carries the secret');
        for (let i = 0; i < 4; i++) assert.strictEqual((await api('POST', '/webhooks', alex, { url: `https://hooks.example.com/${i}`, events: ['bot.robot.online'] })).status, 201);
        assert.strictEqual((await api('POST', '/webhooks', alex, { url: 'https://hooks.example.com/6', events: ['bot.robot.online'] })).status, 409);
    });

    await check('an event writes a delivery with it; the sender signs it like Events and retries a failing receiver', async () => {
        await t.db.query("DELETE FROM robot_webhook_deliveries");
        assert.strictEqual((await api('POST', '/estop', alex)).status, 200);
        const rows = await t.db.many("SELECT * FROM robot_webhook_deliveries WHERE webhook_id = $1", [hookId]);
        assert.strictEqual(rows.length, 1, 'one delivery, written with the event');
        const got = [];
        let answer = 500;
        const sender = createWebhooks({ db: t.db, post: async (url, { headers, body }) => { got.push({ url, headers, body }); return { status: answer }; }, tickMs: 0 });
        assert.strictEqual(await sender.sendDue(), 1);
        const first = got[0];
        assert.strictEqual(first.url, 'https://hooks.example.com/robot');
        const body = JSON.parse(first.body);
        assert.deepStrictEqual([body.type, body.robot_id], ['bot.estop.set', robot.id]);
        assert.ok(verifyDeliveryV2(first.body, first.headers, secret), 'the signature verifies with the hook\'s secret');
        assert.ok(!verifyDeliveryV2(first.body, first.headers, 'whsec_wrong'), 'and with nothing else');
        assert.strictEqual(first.headers['X-OpenVibe-Event'], 'bot.estop.set');
        let row = await t.db.maybe('SELECT * FROM robot_webhook_deliveries WHERE id = $1', [rows[0].id]);
        assert.deepStrictEqual([row.state, row.attempts, row.last_status], ['pending', 1, 500]);
        assert.ok(Date.parse(row.due_at) > Date.now() + (BACKOFF_S[0] - 2) * 1000, 'retried after 30 s');
        for (let i = 0; i < BACKOFF_S.length; i++) {
            await t.db.query('UPDATE robot_webhook_deliveries SET due_at = now() WHERE id = $1', [row.id]);
            await sender.sendDue();
        }
        row = await t.db.maybe('SELECT * FROM robot_webhook_deliveries WHERE id = $1', [rows[0].id]);
        assert.deepStrictEqual([row.state, row.attempts], ['failed', BACKOFF_S.length + 1], 'it gives up');
        answer = 204;
        assert.strictEqual((await api('POST', '/estop/clear', alex)).status, 200);
        await sender.sendDue();
        const cleared = await t.db.maybe("SELECT * FROM robot_webhook_deliveries WHERE webhook_id = $1 AND event_type = 'bot.estop.cleared'", [hookId]);
        assert.deepStrictEqual([cleared.state, cleared.last_status], ['delivered', 204]);
    });

    await check('the owner\'s panel has both cards; a bad routine answers 422 with the form; a new hook\'s secret shows once', async () => {
        const cookie = { Cookie: `ov_token=${t.network.signUser(alex)}` };
        const html = await (await fetch(`${t.base}/panel/${robot.id}`, { headers: cookie })).text();
        assert.ok(html.includes('id="routines"') && html.includes('Patrol') && html.includes('id="webhooks"') && html.includes('hooks.example.com/robot'));
        assert.ok(html.includes('<code>headlights #ff8800</code>'), 'the help line lists this robot\'s own steps');
        assert.ok(!html.includes(secret), 'the secret is not on the panel again');
        const form = (path, body) => fetch(`${t.base}${path}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams(body).toString(), headers: { ...cookie, 'Content-Type': 'application/x-www-form-urlencoded' } });
        const bad = await form(`/robots/${robot.id}/routines`, { name: 'Nope', steps: 'jump 2', trigger: 'manual' });
        assert.strictEqual(bad.status, 422);
        assert.match(await bad.text(), /&quot;jump&quot; is not a step this robot knows/);
        const ok = await form(`/robots/${robot.id}/routines`, { name: 'Weekdays', steps: 'forward 1', trigger: 'daily', at: '08:15', days: '1' });
        assert.strictEqual(ok.status, 303);
        await t.db.query('DELETE FROM robot_webhooks WHERE robot_id = $1', [robot.id]);
        const hook = await form(`/robots/${robot.id}/webhooks`, { url: 'https://hooks.example.com/panel', events: 'bot.robot.online' });
        assert.strictEqual(hook.status, 201);
        assert.match(await hook.text(), /shown this once: <code>whsec_/);
    });

    t.app.locals.sim.stopAll();
    routines.stop();
    await t.close();
    done();
})();
