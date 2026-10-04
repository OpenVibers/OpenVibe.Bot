'use strict';
// The embeddable panel (plan T15 step R9, s2): GET /panel/:id/embed framed only by BOT_EMBED_ORIGINS, and the
// anonymous read-only /watch socket that carries an embed_public robot's public state and nothing else.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { loadConfig } = require('../server/config');
const { renderPanel } = require('../server/web/render');

(async () => {
    const SIM = { id: 'sim.rover', name: 'Simulated rover', commands: { drive: { axes: { throttle: [-1, 1], steer: [-1, 1] } } }, widgets: [{ type: 'drive', label: 'Drive', command: { kind: 'drive' } }, { type: 'latency', label: 'Latency' }] };
    const robotRow = { id: 'rob_e1', name: 'Rover', profile_id: 'sim.rover', estop: { latched: false } };

    await check('BOT_WATCH_MAX_PER_IP and BOT_WATCH_MAX_PER_ROBOT default to 20 and 500', () => {
        assert.deepStrictEqual(loadConfig({}).watch, { maxPerIp: 20, maxPerRobot: 500 });
        assert.deepStrictEqual(loadConfig({ BOT_WATCH_MAX_PER_IP: '3', BOT_WATCH_MAX_PER_ROBOT: '0' }).watch, { maxPerIp: 3, maxPerRobot: 1 });
    });

    await check('embed mode: no topbar, the e-stop state always, controls only for the role, links open a new tab', () => {
        const watcher = renderPanel({ robot: robotRow, profile: SIM, role: 'watcher', allowed_commands: [], mode: 'embed', signedIn: false });
        assert.ok(watcher.includes('class="embed-page"') && !watcher.includes('class="topbar"'));
        assert.ok(watcher.includes('data-estop-banner') && watcher.includes('data-estop-state'));
        assert.ok(!watcher.includes('data-estop>') && !watcher.includes('data-estop-clear') && !watcher.includes('data-embed-form'));
        assert.ok(watcher.includes('data-role="watcher"') && watcher.includes('data-allowed="[]"'));
        assert.ok(!/<button(?![^>]*disabled)[^>]*data-(hold|stop)/.test(watcher), 'a control is enabled for a watcher');
        assert.match(watcher, /<a class="button" href="\/panel\/rob_e1" target="_blank" rel="noopener">Sign in to control<\/a>/);
        for (const a of watcher.match(/<a [^>]*>/g)) assert.ok(a.includes('target="_blank"') && a.includes('rel="noopener"'), a);
        const signedIn = renderPanel({ robot: robotRow, profile: SIM, role: 'watcher', allowed_commands: [], mode: 'embed', signedIn: true });
        assert.ok(!signedIn.includes('Sign in to control'));
        const owner = renderPanel({ robot: { ...robotRow, embed_public: true }, profile: SIM, role: 'owner', allowed_commands: ['drive', 'halt'], mode: 'embed' });
        assert.ok(owner.includes('data-estop>') && owner.includes('data-estop-clear') && !owner.includes('data-embed-form') && !owner.includes('<a '));
        const page = renderPanel({ robot: robotRow, profile: SIM, role: 'owner', allowed_commands: ['drive'] });
        assert.ok(page.includes('class="panel-page"') && page.includes('class="topbar"') && page.includes('data-embed-form'));
    });

    await check('the panel client: a watcher joins on /watch and never sends anything but join', () => {
        const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.js'), 'utf8');
        assert.match(js, /const WATCHER = main\.dataset\.role === 'watcher';/);
        assert.match(js, /new WebSocket\(wsUrl\(WATCHER \? '\/watch' : '\/control'\)\)/);
        assert.match(js, /if \(WATCHER && frame\.type !== 'join'\) return false;/);
    });

    const t = await boot({ env: { BOT_WATCH_MAX_PER_IP: '2', BOT_WATCH_MAX_PER_ROBOT: '3' } });
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const get = (p, user) => fetch(t.base + p, { redirect: 'manual', headers: user ? cookie(user) : {} });
    let ipN = 0;
    // Each watcher from its own address unless one is named (the test server trusts one proxy hop, as production).
    const watch = (ip = `10.0.0.${++ipN}`) => t.ws('/watch', { headers: { 'X-Forwarded-For': ip } });
    const EMBED_CSP = "default-src 'self'; frame-ancestors 'self' https://openvibe.live https://www.openvibe.live; object-src 'none'; base-uri 'self'";
    const auditCount = async (id) => (await t.domain.audit.list(id, { limit: 100 })).length;

    const { robot: open } = await t.robot(alex, { name: 'Public rover' });
    await t.domain.robots.setEmbedPublic(open.id, true);
    const { robot: closed } = await t.robot(alex, { name: 'Private rover' });

    await check('GET /panel/:id/embed: a public robot to anyone, with the embed CSP, no cookie and never a redirect', async () => {
        const r = await get(`/panel/${open.id}/embed`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('content-security-policy'), EMBED_CSP);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        assert.strictEqual(r.headers.get('set-cookie'), null);
        const html = await r.text();
        assert.ok(html.includes('data-role="watcher"') && html.includes('data-allowed="[]"') && html.includes('class="embed-page"'));
        assert.ok(html.includes('Sign in to control') && !html.includes('data-estop>'));
        assert.ok(t.hub.isOnline(`dev_sim_${open.id}`), 'the embed starts the simulator as the panel does');
        // The rest of the site still refuses every frame.
        assert.match((await get(`/panel/${open.id}`, alex)).headers.get('content-security-policy'), /frame-ancestors 'self';/);
        assert.match((await get('/robots', alex)).headers.get('content-security-policy'), /frame-ancestors 'self';/);
    });

    await check('a robot that is not public: 403 with a link out and no robot data; unknown: 404; members keep their role', async () => {
        const r = await get(`/panel/${closed.id}/embed`);
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.headers.get('content-security-policy'), EMBED_CSP);
        assert.strictEqual(r.headers.get('set-cookie'), null);
        const html = await r.text();
        assert.ok(!html.includes('Private rover') && !html.includes('data-robot-id'));
        assert.match(html, /href="\/panel\/rob_[0-9A-Za-z]+" target="_blank" rel="noopener">Open on openvibe\.bot</);
        assert.strictEqual((await get(`/panel/${closed.id}/embed`, bob)).status, 403);
        assert.strictEqual((await get('/panel/rob_nothing/embed')).status, 404);
        const owner = await get(`/panel/${closed.id}/embed`, alex);
        assert.strictEqual(owner.status, 200);
        const oh = await owner.text();
        assert.ok(oh.includes('data-role="owner"') && oh.includes('data-estop>') && !oh.includes('data-embed-form') && !oh.includes('Sign in to control'));
        const stranger = await (await get(`/panel/${open.id}/embed`, bob)).text();
        assert.ok(stranger.includes('data-role="watcher"') && !stranger.includes('Sign in to control'));
    });

    await check('/watch: join answers the public state only, and a robot that is not public (or unknown) is refused', async () => {
        const w = await watch();
        w.send({ type: 'join', robot_id: closed.id });
        assert.strictEqual((await w.waitFor((m) => m.type === 'error')).code, 'bot.not_an_operator');
        w.send({ type: 'join', robot_id: 'rob_nothing' });
        await w.waitFor((m) => m.type === 'error' && w.messages.filter((x) => x.type === 'error').length === 2);
        assert.strictEqual(w.messages[1].code, 'bot.not_an_operator');
        w.send({ type: 'join', robot_id: open.id });
        const j = await w.waitFor((m) => m.type === 'joined');
        assert.strictEqual(j.role, 'watcher');
        assert.deepStrictEqual(j.allowed_commands, []);
        assert.strictEqual(j.profile.id, 'sim.rover');
        assert.strictEqual(j.robot, undefined);
        assert.deepStrictEqual(Object.keys(j.state).sort(), ['battery', 'estop', 'latency_ms', 'online', 'robot_id', 'telemetry']);
        assert.deepStrictEqual(Object.keys(j.state.estop), ['latched']);
        const s = await w.waitFor((m) => m.type === 'robot_state' && m.state.telemetry);
        assert.deepStrictEqual(s.state.telemetry, { sensors: {} }, 'the drive and pose telemetry reached a watcher');
        assert.ok(s.state.online && s.state.battery > 0);
        w.close();
    });

    await check('every frame but join/leave answers bot.read_only and reaches neither the device nor the audit', async () => {
        const w = await watch();
        w.send({ type: 'join', robot_id: open.id });
        await w.waitFor((m) => m.type === 'joined');
        const before = await auditCount(open.id);
        for (const f of [{ type: 'command', id: 'x1', kind: 'drive', value: { throttle: 1 } }, { type: 'command', kind: 'halt' }, { type: 'estop' }, { type: 'estop_clear' }, { type: 'pair' }]) w.send(f);
        await w.waitFor(() => w.messages.filter((m) => m.type === 'error').length >= 5);
        assert.deepStrictEqual(w.messages.filter((m) => m.type === 'error').map((m) => m.code), Array(5).fill('bot.read_only'));
        assert.ok(!w.messages.some((m) => m.type === 'command_result'));
        await t.wait(100);
        assert.strictEqual(await auditCount(open.id), before);
        assert.strictEqual((await t.domain.robots.get(open.id)).estop_latched, false);
        const tele = (m) => m.type === 'robot_state' && m.state.telemetry;
        assert.ok(await w.waitFor(tele));
        assert.strictEqual(t.hub.deviceState(`dev_sim_${open.id}`).telemetry.drive.throttle || 0, 0, 'the robot moved');
        w.close();
    });

    await check('the owner\'s e-stop reaches a watcher; readouts carry only the profile\'s sensor keys', async () => {
        const w = await watch();
        w.send({ type: 'join', robot_id: open.id });
        await w.waitFor((m) => m.type === 'joined');
        const c = await t.ws('/control', { headers: cookie(alex) });
        c.send({ type: 'join', robot_id: open.id });
        await c.waitFor((m) => m.type === 'joined');
        c.send({ type: 'estop' });
        assert.ok(await w.waitFor((m) => m.type === 'robot_state' && m.state.estop.latched === true));
        c.send({ type: 'estop_clear' });
        assert.ok(await w.waitFor((m) => m.type === 'robot_state' && m.state.estop.latched === false && w.messages.some((x) => x.state && x.state.estop.latched)));
        c.close(); w.close();

        const { robot: arm } = await t.robot(alex, { name: 'Arm', profile_id: 'adeept.adr036' });
        await t.domain.robots.setEmbedPublic(arm.id, true);
        const dev = t.hub.attachSim({ id: 'dev_fake_arm', robot_ids: JSON.stringify([arm.id]), kind: 'onboard' }, { onFrame() {} });
        await dev.ready;
        const a = await watch();
        a.send({ type: 'join', robot_id: arm.id });
        await a.waitFor((m) => m.type === 'joined');
        dev.deliver({ type: 'telemetry', events: ['bump'], battery: 0.5, sensors: { ultrasonic: 42, secret: 7 }, pose: { x: 1 } });
        const s = await a.waitFor((m) => m.type === 'robot_state' && m.state.telemetry);
        assert.deepStrictEqual(s.state.telemetry, { sensors: { ultrasonic: 42 } });
        assert.strictEqual(s.state.battery, 0.5);
        a.close();
        t.hub.detachSim('dev_fake_arm');
    });

    await check('turning embedding off closes every watcher of the robot with 4003', async () => {
        const { robot } = await t.robot(alex, { name: 'Briefly public' });
        await t.domain.robots.setEmbedPublic(robot.id, true);
        const w = await watch();
        w.send({ type: 'join', robot_id: robot.id });
        await w.waitFor((m) => m.type === 'joined');
        const r = await fetch(`${t.base}/robots/${robot.id}/embed`, { method: 'POST', redirect: 'manual', body: 'embed_public=off', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...cookie(alex) } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(await w.waitForClose(), 4003);
    });

    await check('caps: sockets per address and watchers per robot close 4003; an oversized frame closes the socket', async () => {
        const one = await watch('10.9.9.9');
        const two = await watch('10.9.9.9');
        const three = await watch('10.9.9.9');
        assert.strictEqual(await three.waitForClose(), 4003);
        one.close(); two.close();
        await one.waitForClose(); await two.waitForClose();
        const again = await watch('10.9.9.9');
        again.send({ type: 'join', robot_id: open.id });
        assert.ok(await again.waitFor((m) => m.type === 'joined'), 'the address was not released');

        const { robot } = await t.robot(alex, { name: 'Crowded' });
        await t.domain.robots.setEmbedPublic(robot.id, true);
        const crowd = [];
        for (let i = 0; i < 3; i++) {
            const w = await watch();
            w.send({ type: 'join', robot_id: robot.id });
            await w.waitFor((m) => m.type === 'joined');
            crowd.push(w);
        }
        const late = await watch();
        late.send({ type: 'join', robot_id: robot.id });
        assert.strictEqual(await late.waitForClose(), 4003);
        crowd.forEach((w) => w.close());

        again.ws.send('x'.repeat(5000));
        assert.strictEqual(await again.waitForClose(), 1009);
    });

    t.app.locals.sim.stopAll();
    await t.close();
    done();
})();
