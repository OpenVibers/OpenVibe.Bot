'use strict';
// The T15 lane H proving test: one end-to-end Adeept dry-run through Bot, using the frames OpenVibe.Node
// actually sends (internal/protocol, internal/link, testdata/bot). An owner pairs a fake ADR036, drives
// and actuates it over the /control socket, reads battery and latency back, latches and clears the e-stop,
// and never sees the device's secrets in a read. BOT_WHIP_BASE is set, so pairing must answer a whip_url.
//
// The scenario follows the node-plan-t15-t14 audit's last OpenVibe.Bot item: "an end-to-end Adeept dry-run
// through Bot asserting drive, pan/tilt, lights, horn, battery, latency and video". Video is asserted only
// as the pair answer's whip_url (Bot does not carry the media plane here).
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { loadProfiles } = require('../server/profiles');
const plugins = require('./helpers/plugins');

const WHIP_BASE = 'https://whip.test/ingest';

(async () => {
    const t = await boot({ env: { BOT_WHIP_BASE: WHIP_BASE } });
    const alex = t.network.newUser('alex');
    const contract = plugins.contractFor(loadProfiles().get('adeept.adr036'));

    let robot, paired, dev, op, deviceId;
    const poll = async (fn, ms = 3000) => {
        const end = Date.now() + ms;
        for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await t.wait(25); }
    };
    const result = (id) => op.waitFor((m) => m.type === 'command_result' && m.id === id);

    // ── 1. the owner creates the robot; the fake device pairs over HTTP like `openvibe-node pair` ────
    await check('step 1: an owner robot pairs over HTTP with --robot/--name and gets a whip_url', async () => {
        const created = await t.robot(alex, { profile_id: 'adeept.adr036' });
        robot = created.robot;
        // OpenVibe.Node's cmdPair sends Robot, Code, AgentVersion, DeviceKind, Drivers, Capabilities and Name.
        paired = await t.call('POST', '/api/v1/pair', { token: null, body: {
            robot: robot.id, code: created.pairing.code, agent_version: '0.1.0', device_kind: 'onboard',
            drivers: ['pca9685', 'ads7830'], capabilities: { pca9685: { pan: true, tilt: true } }, name: 'adeept-dry-run',
        } });
        assert.strictEqual(paired.status, 201, paired.text);
        deviceId = paired.json.device_id;
        assert.strictEqual(paired.json.robot_id, robot.id, 'the pair answer names the robot');
        assert.match(deviceId, /^dev_/);
        assert.ok(paired.json.credential && paired.json.credential.length >= 40, 'a credential');
        assert.ok(paired.json.publish_key && paired.json.publish_key.length >= 40, 'a publish key');
        assert.strictEqual(paired.json.whip_url, `${WHIP_BASE}/${paired.json.publish_key}`,
            'the video bootstrap is BOT_WHIP_BASE + the publish key');
        assert.strictEqual(paired.json.profile.id, 'adeept.adr036');
    });

    // ── 2. the socket handshake: hello, config, then the device's first status/estop_state ────────────
    await check('step 2: hello (session/robot_ids/ISO time) then config (allowed, latch false) precede status', async () => {
        dev = await t.ws('/device', { headers: { Authorization: `Bearer ${paired.json.credential}` } });
        const hello = await dev.waitFor((m) => m.type === 'hello');
        assert.ok(hello, 'hello arrived');
        assert.ok(/^sess_/.test(hello.session_id), `a session id: ${hello.session_id}`);
        assert.strictEqual(hello.device_id, deviceId);
        assert.ok(hello.robot_ids.includes(robot.id), 'robot_ids names the robot');
        assert.ok(!Number.isNaN(Date.parse(hello.server_time)), `an ISO server_time: ${hello.server_time}`);
        const config = await dev.waitFor((m) => m.type === 'config');
        assert.ok(config, 'config arrived after hello');
        assert.strictEqual(config.estop_latched, false);
        assert.deepStrictEqual(config.allowed_commands, ['drive', 'actuator', 'halt'], 'the adeept profile takes drive/actuator/halt');
        assert.ok(Number.isInteger(config.heartbeat_ms) && config.heartbeat_ms > 0, `a heartbeat interval: ${config.heartbeat_ms}`);
        // Only now does the Node report: its link holds every frame until hello.
        dev.send({ type: 'status', firmware: 'openvibe-node-0.1.0', capabilities: {}, agent_version: '0.1.0',
            device_kind: 'onboard', os: 'linux', arch: 'arm64', drivers: [], faults: [], estop_latched: false, local_stop: false });
        dev.send({ type: 'estop_state', latched: false, robot_id: robot.id, local_stop: false });
        assert.ok(await poll(() => t.hub.isOnline(deviceId)), 'the device is online');
        assert.strictEqual((await t.domain.robots.get(robot.id)).estop_latched, false, 'a device latch:false does not latch');
    });

    // ── 3. drive, pan, tilt, lights and horn reach the device in the Adeept plugin's shapes ──────────
    await check('step 3: drive/pan/tilt/lights/buzzer arrive as commands the Adeept plugin accepts', async () => {
        op = await t.ws('/control', { headers: { Authorization: `Bearer ${t.network.signUser(alex)}` } });
        op.send({ type: 'join', robot_id: robot.id });
        const joined = await op.waitFor((m) => m.type === 'joined');
        assert.strictEqual(joined.role, 'owner', joined.text || JSON.stringify(joined));
        assert.deepStrictEqual(joined.allowed_commands, ['drive', 'actuator', 'halt']);

        const cases = [
            ['k-drive', 'drive', { throttle: 0.5, steer: -2 }, { throttle: 0.5, steer: -1 }],
            ['k-pan', 'actuator', { name: 'pan', value: 0.4 }, { name: 'pan', value: 0.4 }],
            ['k-tilt', 'actuator', { name: 'tilt', value: -3 }, { name: 'tilt', value: -1 }],
            ['k-lights', 'actuator', { name: 'lights', value: { r: 300, g: 12.4, b: -5 } }, { name: 'lights', value: { r: 255, g: 12, b: 0 } }],
            ['k-horn', 'actuator', { name: 'buzzer', value: { note: 'A4' } }, { name: 'buzzer', value: { hz: 440 } }],
        ];
        for (const [id, kind, value, expected] of cases) {
            op.send({ type: 'command', id, kind, value });
            const got = await Promise.race([
                dev.waitFor((m) => m.type === 'command' && m.ref === id),
                result(id).then((r) => assert.fail(`${kind} ${JSON.stringify(value)}: ${r.result} ${r.code || ''} ${r.reason || ''}`)),
            ]);
            assert.strictEqual(got.kind, kind);
            assert.deepStrictEqual(got.value, expected, `${kind} ${JSON.stringify(value)}`);
            assert.strictEqual(contract.accepts(kind, got.value), null, `${contract.name} accepts ${kind} ${JSON.stringify(got.value)}`);
            assert.strictEqual(got.robot_id, robot.id, 'the command names its robot');
            assert.deepStrictEqual(got.operator, { subject: alex.subject, role: 'owner' }, 'the device knows who sent it');
            assert.ok(/^cmd_/.test(got.id) && got.ref === id, 'the device id is server-minted, the operator id is ref');
            assert.ok(Number.isInteger(got.deadline_ms) && got.deadline_ms > Date.now(), `an absolute future deadline: ${got.deadline_ms}`);
            dev.send({ type: 'ack', id: got.id });
            assert.strictEqual((await result(id)).result, 'ack');
        }
    });

    // ── 4. a Node-shaped battery object becomes a numeric fraction on the robot state ────────────────
    await check("step 4: a Node {volts, percent} battery shows a non-null numeric battery", async () => {
        dev.send({ type: 'telemetry', battery: { volts: 7.42, percent: 59 }, voltage: 7.42, sensors: { ultrasonic: 118, line: [0, 1, 1, 0] } });
        const frame = await op.waitFor((m) => m.type === 'robot_state' && m.state && m.state.telemetry && m.state.telemetry.battery
            && m.state.telemetry.battery.percent === 59);
        assert.strictEqual(frame.state.battery, 0.59, 'the fraction the panel reads');
        assert.ok(typeof frame.state.battery === 'number' && Number.isFinite(frame.state.battery), 'numeric');
        assert.deepStrictEqual(frame.state.telemetry.battery, { volts: 7.42, percent: 59 }, 'the raw object is kept in telemetry');
        assert.strictEqual(frame.state.online, true);
    });

    // ── 5. heartbeat: echo/t/server_time come back, seq stays monotonic, rtt_ms is kept ──────────────
    await check('step 5: heartbeat_ack echoes t and rtt_ms is recorded as the latency', async () => {
        const sentAt = 1738065600500;
        dev.send({ type: 'heartbeat', t: sentAt });
        const ack = await dev.waitFor((m) => m.type === 'heartbeat_ack' && m.t === sentAt);
        assert.strictEqual(ack.echo, sentAt, 'echo carries the device t');
        assert.strictEqual(ack.t, sentAt, 't is the field OpenVibe.Node reads for its RTT');
        assert.ok(!Number.isNaN(Date.parse(ack.server_time)), `a server_time: ${ack.server_time}`);
        // A later beat carrying the measured round trip: Bot keeps it as the connection's latency.
        dev.send({ type: 'heartbeat', t: sentAt + 1000, rtt_ms: 42 });
        await dev.waitFor((m) => m.type === 'heartbeat_ack' && m.t === sentAt + 1000);
        assert.strictEqual(t.hub.deviceState(deviceId).rtt_ms, 42, 'the reported RTT is the recorded latency');
        const seqs = dev.messages.map((m) => m.seq);
        assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), `the envelope seq is monotonic: ${seqs.join(',')}`);
    });

    // ── 6. the owner's e-stop latches, a device report cannot clear it, the owner clears it ──────────
    await check('step 6: owner latch sends estop true and refuses drive; a device false is not a clear', async () => {
        op.send({ type: 'estop' });
        const latched = await dev.waitFor((m) => m.type === 'estop' && m.latched === true);
        assert.ok(latched, 'the device is told to latch');
        assert.ok(await poll(() => t.domain.robots.get(robot.id).then((r) => !!r.estop_latched)), 'the robot is latched');
        op.send({ type: 'command', id: 'e-stop-drive', kind: 'drive', value: { throttle: 0.2 } });
        const refused = await result('e-stop-drive');
        assert.strictEqual(refused.result, 'refused');
        assert.strictEqual(refused.code, 'bot.estop_latched');
        // The device reporting its own latch:false is recorded, never an owner clear.
        dev.send({ type: 'estop_state', latched: false, robot_id: robot.id, local_stop: false });
        await t.wait(60);
        assert.strictEqual((await t.domain.robots.get(robot.id)).estop_latched, true, 'the owner latch stands');
        op.send({ type: 'estop_clear' });
        const cleared = await dev.waitFor((m) => m.type === 'estop' && m.latched === false);
        assert.ok(cleared, 'the owner clear reaches the device as estop false');
        assert.ok(await poll(() => t.domain.robots.get(robot.id).then((r) => !r.estop_latched)), 'the robot is unlatched');
    });

    // ── 7. no owner read route or state frame carries a device secret or a WHIP URL ──────────────────
    await check('step 7: reads and robot_state never contain whip_url, the publish key or the credential', async () => {
        const secrets = [paired.json.credential, paired.json.publish_key, paired.json.whip_url];
        const paths = ['/api/v1/robots', `/api/v1/robots/${robot.id}`, `/api/v1/robots/${robot.id}/devices`,
            `/api/v1/robots/${robot.id}/operators`, `/api/v1/robots/${robot.id}/audit`];
        for (const p of paths) {
            const r = await t.call('GET', p, { user: alex });
            for (const s of secrets) assert.ok(!r.text.includes(s), `${p} leaked ${s.slice(0, 16)}…`);
            assert.ok(!r.text.includes('whip'), `${p} mentioned a WHIP URL`);
        }
        // Let a telemetry frame produce a fresh robot_state (events bypass the sample window), then inspect
        // everything the owner's socket saw.
        dev.send({ type: 'telemetry', battery: { volts: 7.40, percent: 55 }, sensors: { ultrasonic: 90 },
            events: [{ name: 'bump', ts: Date.now() }] });
        const state = await op.waitFor((m) => m.type === 'robot_state' && m.state && m.state.telemetry && m.state.telemetry.sensors && m.state.telemetry.sensors.ultrasonic === 90);
        assert.ok(state, 'a robot_state frame arrived');
        // The joined frame carries the public profile (whose camera transport is "whip"); only the state frames
        // must be free of the device's secrets.
        const serialized = JSON.stringify(op.messages.filter((m) => m.type === 'robot_state'));
        for (const s of secrets) assert.ok(!serialized.includes(s), `robot_state leaked ${s.slice(0, 16)}…`);
        assert.ok(!serialized.includes('whip_url'), 'robot_state mentioned a WHIP URL');
    });

    if (dev) dev.close();
    if (op) op.close();
    await t.close();
    done();
})();
