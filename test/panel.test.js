'use strict';
// The five-minute path and the profile-rendered panel (plan T15 step 3): every profile's widgets render from
// the profile alone, the e-stop is the owner's and an operator's, the signed-in pages answer as the gate does,
// and a `sim` robot is driven by the in-process simulator (telemetry, acks, the deadman).
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { loadProfiles } = require('../server/profiles');
const { renderPanel, renderWidget, renderRobotsPage, renderPairingPage, camerasOf, esc } = require('../server/web/render');
const { DEFAULT_ALLOW } = require('../server/domain');

const robotFor = (profile, extra = {}) => ({ id: 'rob_1', name: 'Rover', profile_id: profile.id, estop: { latched: false }, ...extra });
const allowedFor = (profile, role) => [...(DEFAULT_ALLOW[role] || []).filter((k) => k !== 'halt' && profile.commands[k]), ...(DEFAULT_ALLOW[role] ? ['halt'] : [])];

(async () => {
    const profiles = [...loadProfiles().values()];

    await check('every profile renders each of its widgets, controls enabled only for an allowed kind', () => {
        assert.ok(profiles.length >= 4);
        for (const p of profiles) {
            const html = renderPanel({ robot: robotFor(p), profile: p, role: 'owner', allowed_commands: allowedFor(p, 'owner') });
            for (const w of p.widgets) assert.ok(html.includes(`data-widget="${w.type}"`), `${p.id}: no ${w.type} widget`);
            for (const w of p.widgets.filter((x) => x.command)) {
                assert.doesNotMatch(renderWidget(w, { profile: p, allowed_commands: allowedFor(p, 'owner') }), / disabled/, `${p.id}: ${w.type} is disabled for the owner`);
                assert.match(renderWidget(w, { profile: p, allowed_commands: [] }), / disabled/, `${p.id}: ${w.type} is enabled with no allowed kind`);
            }
            assert.ok(html.includes('<script src="/panel/panel.js" defer></script>'));
            assert.doesNotMatch(html, /<script>|style="/, 'nothing inline (CSP default-src self)');
        }
    });

    await check('the e-stop is shown to the owner and an operator; only the owner gets the clear', () => {
        const p = profiles.find((x) => x.id === 'sim.rover');
        const html = (role) => renderPanel({ robot: robotFor(p, { estop: { latched: true } }), profile: p, role, allowed_commands: allowedFor(p, role) });
        assert.ok(html('owner').includes('data-estop>') && html('owner').includes('data-estop-clear'));
        assert.ok(html('operator').includes('data-estop>') && !html('operator').includes('data-estop-clear'));
        for (const role of ['viewer', 'queue']) {
            assert.ok(!html(role).includes('data-estop>') && !html(role).includes('data-estop-clear'), `${role} sees an e-stop button`);
            assert.ok(html(role).includes('data-estop-banner data-latched="true"'), `${role} does not see the latched banner`);
        }
        assert.match(renderWidget(p.widgets[0], { profile: p, allowed_commands: [] }), /disabled/);
    });

    await check('one camera tile per camera the profile lists, each the placeholder with its shape', () => {
        const tiles = (html) => (html.match(/<figure class="camera" data-camera="/g) || []).length;
        for (const p of profiles.filter((x) => x.widgets.some((w) => w.type === 'camera'))) {
            const html = renderPanel({ robot: robotFor(p), profile: p, role: 'owner', allowed_commands: allowedFor(p, 'owner') });
            assert.strictEqual(tiles(html), camerasOf(p).length, p.id);
            assert.ok(html.includes('Video is not connected yet.'), p.id);
            if (p.camera && p.camera.resolution) assert.ok(html.includes(`data-resolution="${p.camera.resolution}"`), p.id);
            assert.doesNotMatch(html, /<video|whip_url|publish_key/, `${p.id}: no stream address on the page`);
        }
        const p = profiles.find((x) => x.id === 'sim.rover');
        const two = { ...p, camera: [{ name: 'Front', transport: 'whip', resolution: '640x360' }, { name: 'Arm', transport: 'whip', resolution: '320x240' }] };
        const html = renderPanel({ robot: robotFor(two), profile: two, role: 'owner', allowed_commands: [] });
        assert.strictEqual(tiles(html), 2);
        assert.ok(html.includes('data-resolution="320x240"') && html.includes('Arm · 320×240'));
        const one = renderWidget({ type: 'camera', camera: 'Arm' }, { profile: two });
        assert.strictEqual(tiles(one), 1);
        assert.ok(one.includes('data-camera="1"'));
        // A camera widget with no camera entry still holds one slot.
        assert.strictEqual(tiles(renderWidget({ type: 'camera' }, { profile: { ...p, camera: null } })), 1);
    });

    await check('a drive widget is a joystick for two of its axes, hold buttons for the rest, and the latency meter', () => {
        const attr = (html, name) => JSON.parse(new RegExp(`${name}="([^"]+)"`).exec(html)[1].replace(/&quot;/g, '"'));
        for (const p of profiles) {
            for (const w of p.widgets.filter((x) => x.type === 'drive')) {
                const html = renderWidget(w, { profile: p, allowed_commands: allowedFor(p, 'owner') });
                const axes = p.commands[w.command.kind].axes;
                const stick = Object.values(attr(html, 'data-joystick'));
                assert.ok(stick.length >= 1 && stick.every((a) => axes[a]), p.id);
                assert.deepStrictEqual(attr(html, 'data-axes'), axes, p.id);
                for (const a of Object.keys(axes)) assert.strictEqual(html.includes(`data-axis="${a}"`), !stick.includes(a), `${p.id}: ${a}`);
                assert.ok(html.includes('data-stop'));
                assert.match(renderWidget(w, { profile: p, allowed_commands: [] }), /data-joystick="[^"]+" [^>]*aria-disabled="true"/);
            }
        }
        const mecanum = profiles.find((x) => x.id === 'adeept.adr036.mecanum');
        const html = renderWidget(mecanum.widgets.find((w) => w.type === 'drive'), { profile: mecanum, allowed_commands: ['drive'] });
        assert.ok(html.includes('data-axis="rotation"') && !html.includes('data-axis="x"') && !html.includes('data-axis="y"'));
        const latency = renderWidget({ type: 'latency' }, { profile: mecanum });
        for (const slot of ['data-latency', 'data-telemetry-age', 'data-link']) assert.ok(latency.includes(slot), slot);
    });

    await check('the robots page has an empty state and labelled fields; the pairing page waits for the device', () => {
        const empty = renderRobotsPage({ robots: [], profiles: profiles.map((p) => ({ id: p.id, name: p.name })) });
        assert.ok(empty.includes('No robots yet.'));
        for (const label of ['Name', 'Model', 'Who may drive']) assert.ok(empty.includes(`<span class="field-label">${label}</span>`), label);
        for (const v of ['private', 'invite', 'queue']) assert.ok(empty.includes(`value="${v}"`), v);
        const pair = renderPairingPage({ robot: { id: 'rob_1', name: 'Rover' }, pairing: { code: 'ABCD-EFGH', installer: 'curl x', expires_at: 'soon' } });
        assert.ok(pair.includes('data-pair-robot="rob_1"') && pair.includes('Waiting for the device.') && pair.includes('data-pair-open hidden'));
    });

    await check('every value is escaped', () => {
        const p = profiles.find((x) => x.id === 'sim.rover');
        const evil = '<img src=x onerror=alert(1)>"\'&';
        const panel = renderPanel({ robot: robotFor(p, { name: evil, id: 'rob_"x' }), profile: { ...p, name: evil, widgets: [{ ...p.widgets[0], label: evil }] }, role: evil, allowed_commands: [] });
        const robots = renderRobotsPage({ robots: [{ id: 'rob_"x', name: evil, profile_id: evil, access_policy: 'private' }], profiles: [{ id: evil, name: evil }], error: evil, values: { name: evil } });
        const pair = renderPairingPage({ robot: { id: 'rob_"x', name: evil }, pairing: { code: evil, installer: evil, expires_at: evil }, profile: { name: evil } });
        for (const html of [panel, robots, pair]) {
            assert.ok(!html.includes('<img') && !html.includes('rob_"x'), 'an unescaped value');
            assert.ok(html.includes(esc(evil)));
        }
    });

    await check('a person\'s subject is percent-encoded in the remove form action', () => {
        const p = profiles.find((x) => x.id === 'sim.rover');
        const subject = 'usr_a/b?c#d e&';
        const html = renderPanel({
            robot: robotFor(p), profile: p, role: 'owner', allowed_commands: [],
            people: [{ subject, role: 'operator', username: 'x', display_name: 'X' }],
        });
        assert.ok(html.includes(`/operators/${encodeURIComponent(subject)}/remove`), 'the subject is not percent-encoded in the URL');
        assert.ok(!html.includes(`/operators/${subject}/remove`), 'the raw subject is in the URL');
    });

    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const carol = t.network.newUser('carol');
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const get = (p, user, headers = {}) => fetch(t.base + p, { redirect: 'manual', headers: { ...(user ? cookie(user) : {}), ...headers } });
    const post = (p, user, form, headers = {}) => fetch(t.base + p, {
        method: 'POST', redirect: 'manual', body: new URLSearchParams(form).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(user ? cookie(user) : {}), ...headers },
    });
    const control = (user) => t.ws('/control', { headers: cookie(user) });
    const poll = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(20); } return null; };

    await check('/ is the front page (test/home.test.js); /robots.txt and /install are unchanged; the pages need a session', async () => {
        assert.match(await (await get('/')).text(), /<h1>Drive your robot/);
        assert.strictEqual(await (await get('/robots.txt')).text(), 'User-agent: *\nDisallow: /\n');
        assert.strictEqual((await get('/install')).status, 302);
        for (const p of ['/robots', '/panel/rob_x', '/pair/rob_x']) {
            const r = await get(p);
            assert.strictEqual(r.status, 302, p);
            assert.strictEqual(r.headers.get('location'), `/auth/login?next=${encodeURIComponent(p)}`);
        }
        const js = await get('/panel/panel.js');
        assert.strictEqual(js.status, 200);
        assert.match(js.headers.get('content-type'), /javascript/);
        assert.match((await get('/panel/panel.css')).headers.get('content-type'), /text\/css/);
    });

    let simId;
    await check('POST /robots (sim.rover) → its panel, 200 with the profile\'s widgets', async () => {
        const r = await post('/robots', alex, { name: 'Sim', profile_id: 'sim.rover', access_policy: 'private' });
        assert.strictEqual(r.status, 303);
        const m = /^\/panel\/(rob_[0-9A-Za-z]+)$/.exec(r.headers.get('location'));
        assert.ok(m, r.headers.get('location'));
        simId = m[1];
        const page = await get(`/panel/${simId}`, alex);
        assert.strictEqual(page.status, 200);
        assert.strictEqual(page.headers.get('cache-control'), 'no-store');
        const html = await page.text();
        for (const w of ['drive', 'camera', 'latency']) assert.ok(html.includes(`data-widget="${w}"`), w);
        assert.ok(html.includes(`data-robot-id="${simId}"`) && html.includes('data-role="owner"') && html.includes('data-estop>'));
        const list = await (await get('/robots', alex)).text();
        assert.ok(list.includes(`/panel/${simId}`));
        await t.wait(50);
        const simEvents = (await t.outboxRows()).filter((e) => e.payload && String(e.payload.device_id || '').startsWith('dev_sim_'));
        assert.deepStrictEqual(simEvents, [], 'a simulator is reported online in the outbox');
    });

    await check('a sim robot has telemetry within 1 s and acks a command; the deadman stops it', async () => {
        const { robot } = await t.robot(alex, { name: 'Sim 2' });
        assert.strictEqual(await t.app.locals.sim.attach(robot.id), true);
        assert.ok(await poll(() => t.hub.deviceState(`dev_sim_${robot.id}`).telemetry, 1000), 'no telemetry within 1 s');
        assert.strictEqual(t.hub.onlineCount(), 0, 'a simulator is not counted as a device');
        const c = await control(alex);
        c.send({ type: 'join', robot_id: robot.id });
        const joined = await c.waitFor((m) => m.type === 'joined');
        assert.ok(joined.allowed_commands.includes('drive'));
        c.send({ type: 'command', id: 'd1', kind: 'drive', value: { throttle: 0.5 } });
        const res = await c.waitFor((m) => m.type === 'command_result' && m.id === 'd1');
        assert.strictEqual(res.result, 'ack');
        // Held as the panel holds it (a fresh id every 100 ms): moving; let go: the deadman stops it by itself.
        const moving = (m) => m.type === 'robot_state' && m.state.telemetry && m.state.telemetry.drive.throttle === 0.5;
        let n = 0;
        const hold = setInterval(() => c.send({ type: 'command', id: `h${++n}`, kind: 'drive', value: { throttle: 0.5 } }), 100);
        try { assert.ok(await c.waitFor(moving), 'moving'); } finally { clearInterval(hold); }
        const after = c.messages.length;
        assert.ok(await c.waitFor((m) => c.messages.indexOf(m) >= after && m.type === 'robot_state' && m.state.telemetry && m.state.telemetry.drive.throttle === 0), 'stopped at the deadline');
        c.close();
        t.app.locals.sim.stop(robot.id);
        assert.strictEqual(t.hub.isOnline(`dev_sim_${robot.id}`), false);
    });

    await check('a signed-in person with no role gets 403 and join answers bot.not_an_operator', async () => {
        const r = await get(`/panel/${simId}`, bob);
        assert.strictEqual(r.status, 403);
        const c = await control(bob);
        c.send({ type: 'join', robot_id: simId });
        const e = await c.waitFor((m) => m.type === 'joined' || m.type === 'error');
        assert.strictEqual(e.type, 'error');
        assert.strictEqual(e.code, 'bot.not_an_operator');
        c.close();
        assert.strictEqual((await get('/panel/rob_nothing', bob)).status, 404);
    });

    await check('a viewer member gets the panel with nothing to drive; a stranger on a queue robot gets the queue role', async () => {
        await t.call('POST', `/api/v1/robots/${simId}/operators`, { user: alex, body: { subject: carol.subject, role: 'viewer' } });
        const html = await (await get(`/panel/${simId}`, carol)).text();
        assert.ok(html.includes('data-role="viewer"') && html.includes('data-allowed="[]"') && !html.includes('data-estop>'));
        const { robot } = await t.robot(alex, { name: 'Queue', access_policy: 'queue' });
        const q = await (await get(`/panel/${robot.id}`, bob)).text();
        assert.ok(q.includes('data-role="queue"'));
    });

    await check('POST /robots (a hardware profile) → 201 with the code create minted; /pair/:id is the owner\'s', async () => {
        const r = await post('/robots', alex, { name: 'Arm', profile_id: 'adeept.adr036' });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        const created = await r.text();
        const code = /class="code">([0-9A-Z]{4}-[0-9A-Z]{4})</.exec(created);
        assert.ok(code, 'no pairing code on the 201 page');
        assert.match(created, /--driver adeept</);
        const id = /--robot (rob_[0-9A-Za-z]+)/.exec(created)[1];
        // The shown code is the robot's only one: it redeems.
        const paired = await t.call('POST', '/api/v1/pair', { body: { code: code[1], robot: id } });
        assert.strictEqual(paired.status, 201, paired.text);
        const loc = `/pair/${id}`;
        const page = await get(loc, alex);
        assert.strictEqual(page.status, 200);
        const html = await page.text();
        assert.match(html, /class="code">[0-9A-Z]{4}-[0-9A-Z]{4}</);
        assert.ok(html.includes('data-copy'));
        assert.strictEqual((await get(loc, bob)).status, 403);
    });

    await check('the pairing page\'s indicator: the owner\'s /control join reports the device and flips when it connects', async () => {
        const { robot } = await t.robot(alex, { name: 'Indicator', profile_id: 'adeept.adr036' });
        const html = await (await get(`/pair/${robot.id}`, alex)).text();
        assert.ok(html.includes(`data-pair-robot="${robot.id}"`) && html.includes('Waiting for the device.'));
        const code = /class="code">([0-9A-Z]{4}-[0-9A-Z]{4})</.exec(html)[1];
        const c = await control(alex);
        c.send({ type: 'join', robot_id: robot.id });
        const joined = await c.waitFor((m) => m.type === 'joined');
        assert.strictEqual(joined.state.online, false);
        const p = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code } });
        assert.strictEqual(p.status, 201, p.text);
        const dev = await t.ws('/device', { headers: { Authorization: `Bearer ${p.json.credential}` } });
        const up = await c.waitFor((m) => m.type === 'robot_state' && m.state && m.state.online === true);
        assert.ok(up, 'no online flip');
        dev.close();
        assert.ok(await c.waitFor((m) => c.messages.indexOf(m) > c.messages.indexOf(up) && m.type === 'robot_state' && m.state.online === false), 'no offline flip');
        c.close();
    });

    await check('/pair/:id mints nothing for a cross-site navigation or a prefetch', async () => {
        const { robot } = await t.robot(alex, { name: 'Fenced', profile_id: 'adeept.adr036' });
        const live = async () => (await t.db.many('SELECT id FROM pairing_codes WHERE robot_id = $1 AND used_at IS NULL', [robot.id])).map((x) => x.id);
        const before = await live();
        for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Purpose': 'prefetch' }, { Purpose: 'prefetch' }]) {
            const r = await get(`/pair/${robot.id}`, alex, headers);
            assert.strictEqual(r.status, 303, JSON.stringify(headers));
            assert.strictEqual(r.headers.get('location'), '/robots');
        }
        assert.deepStrictEqual(await live(), before, 'a code was replaced');
        assert.strictEqual((await get(`/pair/${robot.id}`, alex, { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
        assert.notDeepStrictEqual(await live(), before);
    });

    await check('the form and /pair/:id count against the person\'s bot.robot.manage limit', async () => {
        const dave = t.network.newUser('dave');
        const { robot } = await t.robot(dave, { name: 'Limited', profile_id: 'adeept.adr036' });
        const statuses = [];
        for (let i = 0; i < 31; i++) statuses.push((await get(`/pair/${robot.id}`, dave)).status);
        assert.strictEqual(statuses[0], 200);
        assert.strictEqual(statuses[statuses.length - 1], 429, statuses.join(','));
        assert.strictEqual((await post('/robots', dave, { name: 'More', profile_id: 'sim.rover' })).status, 429);
        // Another person is counted apart.
        assert.strictEqual((await get('/robots', alex)).status, 200);
        assert.notStrictEqual((await post('/robots', alex, { name: 'Mine', profile_id: 'adeept.adr036' })).status, 429);
    });

    await check('a bad form answers 422 with the form; a cross-site post is refused', async () => {
        const bad = await post('/robots', alex, { name: '', profile_id: 'sim.rover' });
        assert.strictEqual(bad.status, 422);
        assert.match(await bad.text(), /class="error"/);
        const unknown = await post('/robots', alex, { name: 'X', profile_id: 'nope' });
        assert.strictEqual(unknown.status, 422);
        const cross = await post('/robots', alex, { name: 'X', profile_id: 'sim.rover' }, { Origin: 'https://evil.test' });
        assert.strictEqual(cross.status, 403);
        assert.strictEqual((await post('/robots', null, { name: 'X', profile_id: 'sim.rover' })).status, 302);
    });

    t.app.locals.sim.stopAll();
    await t.close();
    done();
})();
