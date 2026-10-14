'use strict';
// The simulated rover (plan T15 "a simulated robot in the browser lets anyone try the panel before owning hardware"):
// the shared arena (public/sim-world.js) both ends use, /try's page (the real panel on a rover that runs in the
// visitor's browser), and Bot's in-process simulator moving in the same arena and reporting what a real rover would.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const world = require('../public/sim-world');
const { loadProfiles } = require('../server/profiles');

(async () => {
    await check('the arena: the rover starts free on the tape, a wall stops it, sensors read what is ahead and below', () => {
        assert.strictEqual(world.blocked(world.START.x, world.START.y), false, 'the start is clear');
        assert.deepStrictEqual(world.line(world.START), { left: false, middle: true, right: false }, 'parked centred on the tape');
        let pose = { ...world.START };
        let bumped = false;
        const before = world.distanceCm(pose);
        for (let i = 0; i < 200 && !bumped; i++) ({ pose, bumped } = world.step(pose, { throttle: 1, steer: 0 }, 0.05));
        assert.ok(bumped, 'driving straight on ends at a wall');
        assert.ok(pose.y > world.START.y + 3, `it got across the arena (${pose.y})`);
        assert.ok(world.distanceCm(pose) < 15 && world.distanceCm(pose) < before, 'the range finder reads the wall it touches');
        assert.strictEqual(world.blocked(pose.x, pose.y), false, 'a bump never leaves the rover inside a solid');
        const turned = world.step(world.START, { throttle: 0, steer: 1 }, 0.5).pose;
        assert.ok(Math.abs(turned.heading - 45) < 1e-9 && turned.x === world.START.x, 'a right steer turns right on the spot (heading 0 → 45 in 0.5 s)');
        assert.strictEqual(world.floorAt(world.START.x, world.START.y), 'line');
        assert.ok(['tile', 'tile2'].includes(world.floorAt(4, 1)), 'off the tape is floor');
        const ray = world.cast(4, 1, 0, 20);
        assert.ok(ray.length >= 1 && ray.at(-1).cell === '#', 'every ray ends at the arena wall');
    });

    await check('sim.rover v2 has what /try drives: drive, camera, range and line sensors, battery, headlights, horn', () => {
        const p = loadProfiles().get('sim.rover');
        assert.deepStrictEqual(p.widgets.map((w) => w.type), ['camera', 'drive', 'telemetry', 'telemetry', 'battery', 'lights', 'horn', 'latency']);
        assert.deepStrictEqual(Object.keys(p.commands.actuator.names).sort(), ['headlights', 'horn']);
    });

    const t = await boot();
    const alex = t.network.newUser('alex');
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const get = (p, user) => fetch(t.base + p, { redirect: 'manual', headers: user ? cookie(user) : {} });
    const poll = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(20); } return null; };

    await check('GET /try: the real panel on a rover in the visitor\'s browser, public, no session, nothing from outside', async () => {
        const r = await get('/try');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('cache-control'), /^public/);
        assert.strictEqual(r.headers.get('set-cookie'), null);
        assert.doesNotMatch(r.headers.get('content-security-policy') || '', /esm\.sh|openre/, 'no outside script or socket');
        const html = await r.text();
        assert.ok(html.includes('data-transport="local"') && html.includes('data-role="owner"') && html.includes('data-sim-camera'));
        const scripts = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
        assert.deepStrictEqual(scripts, ['/panel/sim-world.js', '/panel/try-device.js', '/panel/panel.js', '/panel/sim-view.js'], 'the rover and its socket before the panel, the camera after');
        const json = /<script type="application\/json" id="try-profile">([^<]*)<\/script>/.exec(html);
        assert.ok(json, 'the profile rides along as data');
        assert.deepStrictEqual(JSON.parse(json[1]), loadProfiles().get('sim.rover'));
        assert.ok(html.includes('<link rel="canonical" href="https://openvibe.bot/try">') && html.includes('<meta name="description"'));
        assert.ok(html.includes('href="/robots/new"'), 'the way on to a real robot');
        for (const s of scripts) {
            const js = await get(s);
            assert.strictEqual(js.status, 200, s);
            assert.match(js.headers.get('content-type'), /javascript/, s);
        }
        assert.ok((await (await get('/sitemap.xml')).text()).includes('<loc>http://bot.test/try</loc>'));
        assert.ok((await (await get('/llms.txt')).text()).includes('http://bot.test/try'));
        assert.doesNotMatch(await (await get('/robots.txt')).text(), /Disallow: \/try/);
    });

    await check('the in-process simulator moves in the arena and reports range, line and its pose for the camera', async () => {
        const { robot } = await t.robot(alex, { name: 'Arena', profile_id: 'sim.rover' });
        assert.strictEqual(await t.app.locals.sim.attach(robot.id), true);
        const tel = await poll(() => t.hub.deviceState(`dev_sim_${robot.id}`).telemetry, 2000);
        assert.ok(tel, 'telemetry');
        assert.deepStrictEqual(tel.sim.pose, { ...world.START }, 'it starts where /try starts');
        assert.ok(Number.isInteger(tel.sensors.distance_cm) && tel.sensors.line.middle === true);
        const c = await t.ws('/control', { headers: cookie(alex) });
        c.send({ type: 'join', robot_id: robot.id });
        await c.waitFor((m) => m.type === 'joined');
        c.send({ type: 'command', id: 'l1', kind: 'actuator', value: { name: 'headlights', value: { r: 255, g: 200, b: 40 } } });
        assert.strictEqual((await c.waitFor((m) => m.type === 'command_result' && m.id === 'l1')).result, 'ack');
        let n = 0;
        const hold = setInterval(() => c.send({ type: 'command', id: `f${++n}`, kind: 'drive', value: { throttle: 1 } }), 100);
        let moved;
        try {
            moved = await poll(() => { const s = t.hub.deviceState(`dev_sim_${robot.id}`).telemetry; return s && s.sim.pose.y > world.START.y + 0.3 ? s : null; }, 4000);
        } finally { clearInterval(hold); }
        assert.ok(moved, 'held forward, it drives up the tape');
        assert.deepStrictEqual(moved.sim.headlights, { r: 255, g: 200, b: 40 }, 'the camera knows its lights');
        assert.ok(moved.sensors.distance_cm < tel.sensors.distance_cm, 'closer to what is ahead');
        c.close();
        t.app.locals.sim.stop(robot.id);
    });

    await check('a watcher sees a sim robot\'s pose (numbers only) and a real robot\'s readouts by the driver\'s keys', async () => {
        const { robot } = await t.robot(alex, { name: 'Shown', profile_id: 'sim.rover' });
        await t.domain.robots.setEmbedPublic(robot.id, true);
        assert.strictEqual(await t.app.locals.sim.attach(robot.id), true);
        const w = await t.ws('/watch', { headers: { 'X-Forwarded-For': '10.9.0.1' } });
        w.send({ type: 'join', robot_id: robot.id });
        const s = await w.waitFor((m) => m.type === 'robot_state' && m.state.telemetry && m.state.telemetry.sim);
        const tel = s.state.telemetry;
        assert.deepStrictEqual(Object.keys(tel.sim).sort(), ['bumped', 'drive', 'headlights', 'horn', 'pose']);
        assert.deepStrictEqual(Object.keys(tel.sensors).sort(), ['distance_cm', 'line'], 'the range finder and line readouts under the keys the Node reports');
        assert.ok(!('drive' in tel) && !('pose' in tel), 'nothing else of the telemetry');
        w.close();
        t.app.locals.sim.stop(robot.id);
    });

    await t.close();
    done();
})();
