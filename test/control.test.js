'use strict';
// The control gate (ADR-043 decisions 6 and 8): roles, the access policy, owner limits that clamp an
// operator, cooldowns, the latched e-stop (owner-cleared only), the turn queue and a service acting for
// a viewer. Every decision is audited.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { loadProfiles } = require('../server/profiles');
const plugins = require('./helpers/plugins');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const carol = t.network.newUser('carol');
    const dave = t.network.newUser('dave');

    const op = (user) => t.ws('/control', { headers: { Authorization: `Bearer ${t.network.signUser(user)}` } });
    async function joinResult(client, robotId) {
        client.send({ type: 'join', robot_id: robotId });
        return client.waitFor((m) => m.type === 'joined' || m.type === 'error');
    }
    async function deviceFor(robotId, code) {
        const p = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robotId, code } });
        const dev = await t.ws('/device', { headers: { Authorization: `Bearer ${p.json.credential}` } });
        await dev.waitFor((m) => m.type === 'hello');
        return dev;
    }
    const invite = (robotId, subject, role) => t.call('POST', `/api/v1/robots/${robotId}/operators`, { user: alex, body: { subject, role } });
    const cmd = (client, o) => client.send({ type: 'command', ...o });
    const result = (client, id) => client.waitFor((m) => m.type === 'command_result' && m.id === id);

    await check('a private robot refuses a stranger', async () => {
        const { robot } = await t.robot(alex);
        const stranger = await op(carol);
        const r = await joinResult(stranger, robot.id);
        assert.strictEqual(r.type, 'error');
        assert.strictEqual(r.code, 'bot.not_an_operator');
        stranger.close();
    });

    await check('the owner\'s limits clamp an operator\'s values; the audit keeps the clamped value', async () => {
        const { robot, pairing } = await t.robot(alex, { limits: { max_speed: 0.4, max_turn: 0.3 } });
        await invite(robot.id, bob.subject, 'operator');
        const dev = await deviceFor(robot.id, pairing.code);
        const b = await op(bob);
        const j = await joinResult(b, robot.id);
        assert.strictEqual(j.role, 'operator');
        cmd(b, { id: 'k1', kind: 'drive', value: { throttle: 5, steer: 5 } });
        const c = await dev.waitFor((m) => m.type === 'command' && m.ref === 'k1');
        assert.deepStrictEqual(c.value, { throttle: 0.4, steer: 0.3 });
        dev.send({ type: 'ack', id: c.id });
        await result(b, 'k1');
        const audit = await t.domain.audit.list(robot.id, { limit: 1 });
        assert.deepStrictEqual(audit[0].value, { throttle: 0.4, steer: 0.3 });
        b.close();
    });

    await check('a cooldown refuses the operator\'s second command of a kind', async () => {
        const { robot, pairing } = await t.robot(alex, { limits: { cooldown_ms: 1000 } });
        await invite(robot.id, bob.subject, 'operator');
        const dev = await deviceFor(robot.id, pairing.code);
        const b = await op(bob);
        await joinResult(b, robot.id);
        cmd(b, { id: 'z1', kind: 'drive', value: { throttle: 0.2 } });
        await dev.waitFor((m) => m.type === 'command' && m.ref === 'z1');
        cmd(b, { id: 'z2', kind: 'drive', value: { throttle: 0.2 } });
        const again = await result(b, 'z2');
        assert.strictEqual(again.result, 'refused');
        assert.strictEqual(again.code, 'bot.cooldown');
        b.close();
    });

    await check('the e-stop latches, refuses commands, and only the owner clears it', async () => {
        const { robot, pairing } = await t.robot(alex);
        await invite(robot.id, bob.subject, 'operator');
        const dev = await deviceFor(robot.id, pairing.code);
        const b = await op(bob);
        await joinResult(b, robot.id);
        b.send({ type: 'estop' });
        assert.ok(await poll(() => t.domain.robots.get(robot.id).then((r) => !!r.estop_latched)), 'the e-stop latched');
        cmd(b, { id: 'e1', kind: 'drive', value: { throttle: 0.2 } });
        const refused = await result(b, 'e1');
        assert.strictEqual(refused.code, 'bot.estop_latched');
        b.send({ type: 'estop_clear' });
        const denied = await b.waitFor((m) => m.type === 'error' && /forbidden/.test(m.code));
        assert.strictEqual(denied.code, 'bot.forbidden');
        const a = await op(alex);
        await joinResult(a, robot.id);
        a.send({ type: 'estop_clear' });
        assert.ok(await poll(() => t.domain.robots.get(robot.id).then((r) => !r.estop_latched)), 'the owner cleared it');
        cmd(b, { id: 'e2', kind: 'drive', value: { throttle: 0.2 } });
        assert.ok(await dev.waitFor((m) => m.type === 'command' && m.ref === 'e2'), 'an operator may drive again');
        a.close(); b.close();
    });

    await check('halt passes the gate while the e-stop is latched; every other kind is refused', async () => {
        const { robot, pairing } = await t.robot(alex, { limits: { cooldown_ms: 60000, allow: { operator: ['drive'] } } });
        await invite(robot.id, bob.subject, 'operator');
        const dev = await deviceFor(robot.id, pairing.code);
        const b = await op(bob);
        const j = await joinResult(b, robot.id);
        assert.deepStrictEqual(j.allowed_commands, ['drive', 'halt'], 'no allowlist removes halt');
        b.send({ type: 'estop' });
        assert.ok(await poll(() => t.domain.robots.get(robot.id).then((r) => !!r.estop_latched)), 'the e-stop latched');
        cmd(b, { id: 'h0', kind: 'drive', value: { throttle: 0.2 } });
        assert.strictEqual((await result(b, 'h0')).code, 'bot.estop_latched');
        cmd(b, { id: 'h1', kind: 'halt' });
        const h1 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'h1');
        assert.strictEqual(h1.kind, 'halt');
        assert.deepStrictEqual(h1.value, {});
        assert.strictEqual(h1.deadline_ms, null, 'halt is not a motion with a deadline');
        dev.send({ type: 'ack', id: h1.id });
        assert.strictEqual((await result(b, 'h1')).result, 'ack');
        cmd(b, { id: 'h2', kind: 'halt' });
        const h2 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'h2');
        assert.ok(h2, 'halt is never cooled down');
        const audit = await t.domain.audit.list(robot.id, { limit: 5 });
        assert.ok(audit.some((x) => x.kind === 'halt' && x.result === 'ack'), 'halt is audited like any command');
        b.close();
    });

    await check('the profile decides the kinds and shapes: a mecanum drive keeps x/y/rotation, an actuator is {name, value}', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'adeept.adr036.mecanum', limits: { max_turn: 0.5 } });
        const dev = await deviceFor(robot.id, pairing.code);
        const a = await op(alex);
        const j = await joinResult(a, robot.id);
        assert.deepStrictEqual(j.allowed_commands, ['drive', 'actuator', 'halt']);
        cmd(a, { id: 'm1', kind: 'drive', value: { x: 0.5, y: -0.4, rotation: 2 } });
        const m1 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'm1');
        assert.deepStrictEqual(m1.value, { x: 0.5, y: -0.4, rotation: 0.5 });
        cmd(a, { id: 'm2', kind: 'actuator', value: { name: 'lights', value: { r: 300, g: 0, b: 7 } } });
        const m2 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'm2');
        assert.deepStrictEqual(m2.value, { name: 'lights', value: { r: 255, g: 0, b: 7 } });
        cmd(a, { id: 'm3', kind: 'actuator', value: { name: 'horn' } });
        assert.strictEqual((await result(a, 'm3')).code, 'bot.unknown_actuator');
        cmd(a, { id: 'm4', kind: 'say', value: { text: 'hi' } });
        const m4 = await result(a, 'm4');
        assert.strictEqual(m4.code, 'bot.command_not_allowed', 'the adeept plugin has no speech');
        a.close();
    });

    // Over the socket, every Adeept (ordinary and mecanum) and Cozmo control reaches the device in the exact
    // shape its Node plugin takes (test/helpers/plugins.js transcribes the plugins).
    const PLUGIN_COMMANDS = {
        'adeept.adr036': [
            ['drive', { throttle: 0.5, steer: -2 }, { throttle: 0.5, steer: -1 }],
            ['actuator', { name: 'pan', value: 0.4 }, { name: 'pan', value: 0.4 }],
            ['actuator', { name: 'tilt', value: -3 }, { name: 'tilt', value: -1 }],
            ['actuator', { name: 'buzzer', value: { note: 'A4' } }, { name: 'buzzer', value: { hz: 440 } }],
            ['actuator', { name: 'buzzer', value: { hz: 5000 } }, { name: 'buzzer', value: { hz: 880 } }],
            ['actuator', { name: 'buzzer', value: null }, { name: 'buzzer', value: null }],
            ['actuator', { name: 'lights', value: { r: 300, g: 12.4, b: -5 } }, { name: 'lights', value: { r: 255, g: 12, b: 0 } }],
            ['actuator', { name: 'lights', value: null }, { name: 'lights', value: null }],
            ['halt', {}, {}],
        ],
        'adeept.adr036.mecanum': [
            ['drive', { x: 0.2, y: -0.7, rotation: 0.3 }, { x: 0.2, y: -0.7, rotation: 0.3 }],
            ['drive', { y: 1 }, { x: 0, y: 1, rotation: 0 }],
            ['actuator', { name: 'pan', value: -0.25 }, { name: 'pan', value: -0.25 }],
            ['actuator', { name: 'tilt', value: 1 }, { name: 'tilt', value: 1 }],
            ['actuator', { name: 'buzzer', value: { note: 'C5' } }, { name: 'buzzer', value: { hz: 523.25 } }],
            ['actuator', { name: 'lights', value: { r: 0, g: 128, b: 255 } }, { name: 'lights', value: { r: 0, g: 128, b: 255 } }],
        ],
        cozmo: [
            ['drive', { throttle: -0.4, steer: 0.2 }, { throttle: -0.4, steer: 0.2 }],
            ['actuator', { name: 'head', value: 0.5 }, { name: 'head', value: 0.5 }],
            ['actuator', { name: 'lift', value: -0.5 }, { name: 'lift', value: 0 }],
            ['actuator', { name: 'lift', value: 2 }, { name: 'lift', value: 1 }],
            ['actuator', { name: 'backpack_lights', value: { r: 1, g: 2, b: 3 } }, { name: 'backpack_lights', value: { r: 1, g: 2, b: 3 } }],
            ['say', { text: 'hello' }, { text: 'hello' }],
            ['display', { face: 'happy' }, { face: 'happy' }],
        ],
    };
    const shipped = loadProfiles();
    for (const [profileId, cases] of Object.entries(PLUGIN_COMMANDS)) {
        await check(`${profileId}: the commands the device gets over the socket are the ones its plugin accepts`, async () => {
            const contract = plugins.contractFor(shipped.get(profileId));
            const { robot, pairing } = await t.robot(alex, { profile_id: profileId });
            const dev = await deviceFor(robot.id, pairing.code);
            const a = await op(alex);
            await joinResult(a, robot.id);
            for (const [i, [kind, value, expected]] of cases.entries()) {
                const id = `${profileId}-${i}`;
                cmd(a, { id, kind, value });
                const got = await Promise.race([
                    dev.waitFor((m) => m.type === 'command' && m.ref === id),
                    a.waitFor((m) => m.type === 'command_result' && m.id === id).then((r) => assert.fail(`${kind} ${JSON.stringify(value)}: ${r.result} ${r.code || ''} ${r.reason || ''}`)),
                ]);
                assert.strictEqual(got.kind, kind);
                assert.deepStrictEqual(got.value, expected, `${kind} ${JSON.stringify(value)}`);
                assert.strictEqual(contract.accepts(kind, got.value), null, `${contract.name} accepts ${kind} ${JSON.stringify(got.value)}`);
                dev.send({ type: 'ack', id: got.id });
                assert.strictEqual((await result(a, id)).result, 'ack');
            }
            a.close(); dev.close();
        });
    }

    await check('config carries the effective limits and is re-sent to the device when the owner changes them', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'cozmo', limits: { max_speed: 0.9, max_turn: 0.5 } });
        const dev = await deviceFor(robot.id, pairing.code);
        const first = await dev.waitFor((m) => m.type === 'config');
        assert.deepStrictEqual(first.limits, { max_speed: 0.6, max_turn: 0.5, max_command_ms: 300, heartbeat_ms: 1000 }, 'the owner\'s clamped by cozmo\'s 0.6');
        assert.deepStrictEqual(first.allowed_commands, ['drive', 'actuator', 'say', 'display', 'halt'], 'cozmo takes no ptz');
        const r = await t.call('PATCH', `/api/v1/robots/${robot.id}`, { user: alex, body: { limits: { max_speed: 0.3, max_turn: 0.2, max_command_ms: 200, allow: { owner: ['drive', 'say'] } } } });
        assert.strictEqual(r.status, 200, r.text);
        const second = await dev.waitFor((m) => m.type === 'config' && m.seq > first.seq);
        assert.deepStrictEqual(second.limits, { max_speed: 0.3, max_turn: 0.2, max_command_ms: 200, heartbeat_ms: 1000 });
        assert.deepStrictEqual(second.allowed_commands, ['drive', 'say', 'halt']);
        const renamed = await t.call('PATCH', `/api/v1/robots/${robot.id}`, { user: alex, body: { name: 'Cozmo II' } });
        assert.strictEqual(renamed.status, 200);
        await t.wait(100);
        assert.strictEqual(dev.messages.filter((m) => m.type === 'config').length, 2, 'a rename does not re-send config');
    });

    await check('a queue robot gives a turn that expires and passes to the next waiting person', async () => {
        const { robot, pairing } = await t.robot(alex, { access_policy: 'queue', limits: { turn_ms: 60000, turn_budget: 5 } });
        // deviceFor, but keeping the credential: the device reconnects past the clock jump below.
        const paired = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
        const deviceHeaders = { Authorization: `Bearer ${paired.json.credential}` };
        let dev = await t.ws('/device', { headers: deviceHeaders });
        await dev.waitFor((m) => m.type === 'hello');
        const c = await op(carol);
        const cj = await joinResult(c, robot.id);
        assert.strictEqual(cj.role, 'queue');
        const d = await op(dave);
        await joinResult(d, robot.id);
        cmd(c, { id: 'q1', kind: 'drive', value: { throttle: 0.2 } });
        const q1 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'q1');
        assert.ok(q1, 'the turn holder may drive');
        dev.send({ type: 'ack', id: q1.id });
        await result(c, 'q1');
        t.clock.offset += 120000;                     // past the 60 s turn
        try {
            // Device liveness runs on the same injected clock (a 200 ms beat, offline after 400 ms here), so
            // the jump drops this link: reconnecting with the same credential replaces the stale socket with
            // one that comes online at the jumped clock, and no real-time race decides whether dave's command
            // reaches the device.
            dev = await t.ws('/device', { headers: deviceHeaders });
            await dev.waitFor((m) => m.type === 'hello');
            cmd(c, { id: 'q2', kind: 'drive', value: { throttle: 0.2 } });
            const rc = await result(c, 'q2');
            assert.strictEqual(rc.result, 'refused', 'the expired turn no longer drives');
            cmd(d, { id: 'q3', kind: 'drive', value: { throttle: 0.2 } });
            assert.ok(await dev.waitFor((m) => m.type === 'command' && m.ref === 'q3'), 'the next waiting person is promoted');
        } finally {
            t.clock.offset -= 120000;
        }
        c.close(); d.close();
    });

    await check('a service token with bot.robot.control acts for a viewer and is held to the viewer role', async () => {
        const { robot, pairing } = await t.robot(alex);
        const viewer = t.network.newUser('viewer');
        await invite(robot.id, viewer.subject, 'viewer');
        await deviceFor(robot.id, pairing.code);
        const svc = t.network.signService({ sub: 'svc:chat', cap: ['bot.robot.control'], aud: ['openvibe.bot'] });
        const s = await t.ws('/control', { headers: { Authorization: `Bearer ${svc}`, 'X-OV-Subject': viewer.subject } });
        const j = await joinResult(s, robot.id);
        assert.strictEqual(j.role, 'viewer');
        cmd(s, { id: 'v1', kind: 'drive', value: { throttle: 0.5 } });
        const r = await result(s, 'v1');
        assert.strictEqual(r.result, 'refused');
        assert.strictEqual(r.code, 'bot.read_only');
        const audit = await t.domain.audit.list(robot.id, { limit: 5 });
        assert.ok(audit.some((x) => x.result === 'refused' && x.reason === 'bot.read_only' && x.operator_kind === 'service'), 'the refusal is audited');
        s.close();

        const noSubject = await t.ws('/control', { headers: { Authorization: `Bearer ${svc}` } });
        assert.strictEqual(await noSubject.waitForClose(), 4002, 'a service must name the subject it acts for');
        const noCap = t.network.signService({ sub: 'svc:chat', cap: ['bot.robot.read'], aud: ['openvibe.bot'] });
        const weak = await t.ws('/control', { headers: { Authorization: `Bearer ${noCap}`, 'X-OV-Subject': viewer.subject } });
        assert.strictEqual(await weak.waitForClose(), 4002, 'without bot.robot.control a service cannot control');
        const anon = await t.ws('/control');
        assert.strictEqual(await anon.waitForClose(), 4002, 'an anonymous socket is refused');
    });

    await check('a service token forwards a command over HTTP and the device\'s ack comes back', async () => {
        const { robot, pairing } = await t.robot(alex);
        await invite(robot.id, bob.subject, 'operator');
        const dev = await deviceFor(robot.id, pairing.code);
        const svc = t.network.signService({ sub: 'svc:live', cap: ['bot.robot.control'], aud: ['openvibe.bot'] });
        const call = (id) => t.call('POST', `/api/v1/robots/${robot.id}/commands`, {
            token: svc, headers: { 'X-OV-Subject': bob.subject }, body: { id, kind: 'drive', value: { throttle: 0.2 } },
        });
        const pending = call('chat-1');   // the route waits for the command_result, so ack before awaiting it
        const c = await dev.waitFor((m) => m.type === 'command' && m.ref === 'chat-1');
        assert.strictEqual(c.kind, 'drive');
        dev.send({ type: 'ack', id: c.id });
        const r = await pending;
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.result, 'ack');
        assert.strictEqual(r.json.id, 'chat-1');
        const audit = await t.domain.audit.list(robot.id, { limit: 5 });
        assert.ok(audit.some((x) => x.kind === 'drive' && x.result === 'ack' && x.operator_kind === 'service'), 'the HTTP command is audited like a socket one');
        // The id is the same per-subject idempotency key as the socket: a repeated id is answered from the cache.
        const again = await call('chat-1');
        assert.strictEqual(again.json.cached, true);
        assert.strictEqual(again.json.result, 'ack');
        dev.close();
    });

    await check('the HTTP command route refuses a service acting for a viewer, and a service without bot.robot.control', async () => {
        const { robot, pairing } = await t.robot(alex);
        await deviceFor(robot.id, pairing.code);
        const svc = t.network.signService({ sub: 'svc:live', cap: ['bot.robot.control'], aud: ['openvibe.bot'] });
        const command = (id, subject, token = svc) => t.call('POST', `/api/v1/robots/${robot.id}/commands`, {
            token, headers: { 'X-OV-Subject': subject }, body: { id, kind: 'drive', value: { throttle: 0.2 } },
        });
        // A chat viewer with no role on the robot is refused exactly as a /control join would refuse them.
        const stranger = t.network.newUser('chatviewer');
        const r = await command('s1', stranger.subject);
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'bot.not_an_operator');
        // An invited viewer has a role, but the gate keeps them read-only (the socket's answer, over HTTP).
        const invited = t.network.newUser('memberviewer');
        await invite(robot.id, invited.subject, 'viewer');
        const ro = await command('s2', invited.subject);
        assert.strictEqual(ro.status, 403, ro.text);
        assert.strictEqual(ro.json.code, 'bot.read_only');
        // Without bot.robot.control a service cannot use the route at all.
        const weak = t.network.signService({ sub: 'svc:live', cap: ['bot.robot.read'], aud: ['openvibe.bot'] });
        const denied = await command('s3', bob.subject, weak);
        assert.strictEqual(denied.status, 403);
        assert.strictEqual(denied.json.code, 'capability.denied');
    });

    // ── The HTTP command route (POST /robots/:id/commands) ────────────────────────────────────────
    // Fixtures go through the domain so these checks do not spend the per-owner `bot.robot.manage` limit the
    // rest of the file already uses; one robot + device (kept online with heartbeats) serves the device checks.
    const hxSetup = await t.domain.robots.create({ owner: alex.subject, name: 'HTTP route rover', profile_id: 'sim.rover' });
    const hx = hxSetup.robot;
    const hdev = await deviceFor(hx.id, hxSetup.pairing.code);
    const svc = t.network.signService({ sub: 'svc:live', cap: ['bot.robot.control'], aud: ['openvibe.bot'] });
    const hcmd = (o) => t.call('POST', `/api/v1/robots/${hx.id}/commands`, { token: svc, headers: { 'X-OV-Subject': o.subject }, body: { id: o.id, kind: o.kind || 'drive', value: o.value || { throttle: 0.2 } } });
    await t.domain.members.add(hx.id, bob.subject, 'operator', alex.subject);
    await t.domain.members.add(hx.id, carol.subject, 'operator', alex.subject);
    // Device liveness here is 400 ms; a heartbeat every 100 ms keeps the shared link online across checks.
    const heartbeat = setInterval(() => { try { hdev.send({ type: 'heartbeat', t: Date.now() }); } catch { /* closing */ } }, 100);

    await check('a person\'s own user token drives the HTTP route, and a mismatched X-OV-Subject is refused', async () => {
        // bob's token with no X-OV-Subject acts as himself, exactly like a WebSocket operator.
        const own = t.call('POST', `/api/v1/robots/${hx.id}/commands`, { user: bob, body: { id: 'me-1', kind: 'drive', value: { throttle: 0.2 } } });
        const c = await hdev.waitFor((m) => m.type === 'command' && m.ref === 'me-1');
        assert.strictEqual(c.operator.subject, bob.subject);
        hdev.send({ type: 'ack', id: c.id });
        const r = await own;
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.result, 'ack');
        // Naming someone else with a user token is refused, never ignored.
        const mismatch = await t.call('POST', `/api/v1/robots/${hx.id}/commands`, { user: bob, headers: { 'X-OV-Subject': carol.subject }, body: { id: 'me-2', kind: 'drive', value: { throttle: 0.2 } } });
        assert.strictEqual(mismatch.status, 403, mismatch.text);
        assert.strictEqual(mismatch.json.code, 'bot.forbidden');
    });

    await check('the HTTP command route needs a subject from a service (422) and refuses an anonymous caller (401)', async () => {
        const noSubject = await t.call('POST', `/api/v1/robots/${hx.id}/commands`, { token: svc, body: { id: 'nos-1', kind: 'drive', value: { throttle: 0.2 } } });
        assert.strictEqual(noSubject.status, 422, noSubject.text);
        assert.strictEqual(noSubject.json.code, 'bot.invalid_input');
        const anon = await t.call('POST', `/api/v1/robots/${hx.id}/commands`, { token: null, body: { id: 'anon-1', kind: 'drive', value: { throttle: 0.2 } } });
        assert.strictEqual(anon.status, 401, anon.text);
        assert.strictEqual(anon.json.code, 'bot.sign_in');
    });

    await check('a latched e-stop and an offline device answer 409 over the HTTP route', async () => {
        // A device-less robot of its own: offline first, then latched (the e-stop is checked before liveness).
        const setup = await t.domain.robots.create({ owner: alex.subject, name: 'No device', profile_id: 'sim.rover' });
        const robot = setup.robot;
        await t.domain.members.add(robot.id, bob.subject, 'operator', alex.subject);
        const send = (id) => t.call('POST', `/api/v1/robots/${robot.id}/commands`, { token: svc, headers: { 'X-OV-Subject': bob.subject }, body: { id, kind: 'drive', value: { throttle: 0.2 } } });
        const offline = await send('off-1');
        assert.strictEqual(offline.status, 409, offline.text);
        assert.strictEqual(offline.json.code, 'bot.device_offline');
        await t.domain.estop.set(robot.id, { latched: true, by: alex.subject, principalKind: 'user' });
        const latched = await send('estop-1');
        assert.strictEqual(latched.status, 409, latched.text);
        assert.strictEqual(latched.json.code, 'bot.estop_latched');
    });

    await check('a different subject reusing an id is never served another subject\'s cached result', async () => {
        const first = hcmd({ id: 'same-1', subject: bob.subject });
        const c1 = await hdev.waitFor((m) => m.type === 'command' && m.ref === 'same-1');
        hdev.send({ type: 'ack', id: c1.id });
        assert.strictEqual((await first).json.result, 'ack');
        // carol's id is her own key: it reaches the device again rather than answering bob's cached ack.
        const second = hcmd({ id: 'same-1', subject: carol.subject });
        const c2 = await hdev.waitFor((m) => m.type === 'command' && m.ref === 'same-1' && m.id !== c1.id);
        hdev.send({ type: 'ack', id: c2.id });
        const r2 = await second;
        assert.strictEqual(r2.status, 200, r2.text);
        assert.strictEqual(r2.json.result, 'ack');
        assert.ok(!r2.json.cached, 'carol was served bob\'s cached result');
    });

    await check('the same id while the first command is in flight answers 409 bot.command_pending', async () => {
        const first = hcmd({ id: 'race-1', subject: bob.subject });
        const c = await hdev.waitFor((m) => m.type === 'command' && m.ref === 'race-1');   // reserved, awaiting the ack
        const second = await hcmd({ id: 'race-1', subject: bob.subject });
        assert.strictEqual(second.status, 409, second.text);
        assert.strictEqual(second.json.code, 'bot.command_pending');
        hdev.send({ type: 'ack', id: c.id });
        const r1 = await first;
        assert.strictEqual(r1.status, 200, r1.text);
        assert.strictEqual(r1.json.result, 'ack');
    });

    await check('the command route rate-limits per acted-for person, not per service token', async () => {
        const setup = await t.domain.robots.create({ owner: alex.subject, name: 'Flood rover', profile_id: 'sim.rover' });
        const robot = setup.robot;
        const floodA = t.network.newUser('floodA');
        const floodB = t.network.newUser('floodB');
        await t.domain.members.add(robot.id, floodA.subject, 'operator', alex.subject);
        await t.domain.members.add(robot.id, floodB.subject, 'operator', alex.subject);
        // No device: every counted call is refused 409 device_offline. The route allows 120/min per person.
        const send = (subject) => t.call('POST', `/api/v1/robots/${robot.id}/commands`, { token: svc, headers: { 'X-OV-Subject': subject }, body: { kind: 'drive', value: { throttle: 0.2 } } });
        // Start well inside a fresh 60 s window so the burst cannot straddle a window boundary.
        const into = Date.now() % 60000;
        if (into > 30000) await t.wait(60000 - into + 100);
        const burst = await Promise.all(Array.from({ length: 120 }, () => send(floodA.subject)));
        assert.ok(burst.every((r) => r.status === 409), 'the first 120 of A\'s calls are counted but not limited');
        const overA = await send(floodA.subject);
        assert.strictEqual(overA.status, 429, 'A exhausts their own bucket');
        assert.strictEqual(overA.json.code, 'rate_limited');
        const overB = await send(floodB.subject);
        assert.strictEqual(overB.status, 409, overB.text);   // B's own bucket is untouched
        assert.notStrictEqual(overB.json.code, 'rate_limited');
    });

    await check('a command the device never acks expires and answers the HTTP route', async () => {
        const pending = hcmd({ id: 'never-1', subject: bob.subject });
        await hdev.waitFor((m) => m.type === 'command' && m.ref === 'never-1');   // the device never acks
        const r = await pending;   // resolves when the deadline passes (expireCommand)
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.result, 'expired');
    });

    // Last: hub.close() stops the hub for good, so this runs after every other check.
    await check('hub.close() settles a pending command as expired so its HTTP request never hangs', async () => {
        const pending = hcmd({ id: 'closing-1', subject: bob.subject });
        await hdev.waitFor((m) => m.type === 'command' && m.ref === 'closing-1');   // in flight; the device never acks
        await t.hub.close();
        clearInterval(heartbeat);
        const r = await pending;
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.result, 'expired');
    });

    await t.close();
    done();
})();

async function poll(fn, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
        if (await fn()) return true;
        if (Date.now() > end) return false;
        await new Promise((r) => setTimeout(r, 25));
    }
}
