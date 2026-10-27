'use strict';
// Buttons under a Live stream, from a streamer's notes (Maticus, 2026-10-25/26: "impossible to put buttons on my
// stream", "the embedding toggle is off by default", "binding is a separate step and nothing points you to it", "who may
// drive is API-only", "driving takes an extra popup and sign-in"):
// - The owner's page leads with "On your stream": one button shows the panel where it is embedded and opens their Live
//   channel's bind prompt; who may drive is chosen beside it. Others cannot do either.
// - POST /api/v1/robots/:id/control-ticket: the page around the frame (Live, a service with bot.robot.control) gets a
//   Drive ticket for a person signed in there: a member, or anyone on a queue robot; the ticket opens /control.
// - The embedded panel asks the allowed page around it for that ticket (and takes it only from there or its own popup);
//   the framed refusal tells that page, so it can hide the box and point the owner to the switch.
// - The wording says what each switch does (the camera mirror is video only).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { renderPanel, renderEmbedRefused } = require('../server/web/render');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const get = (p, user) => fetch(t.base + p, { redirect: 'manual', headers: user ? cookie(user) : {} });
    const post = (p, user, form, headers = {}) => fetch(t.base + p, {
        method: 'POST', redirect: 'manual', body: new URLSearchParams(form).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(user ? cookie(user) : {}), ...headers },
    });
    const row = async (id) => t.db.maybe('SELECT embed_public, access_policy FROM robots WHERE id = $1', [id]);

    const { robot } = await t.robot(alex, { name: 'Cozmo Hobo' });
    const { robot: open } = await t.robot(alex, { name: 'Queue rover', access_policy: 'queue' });

    await check('the owner\'s page leads with "On your stream": the button, who may drive, the plain wording', async () => {
        const page = await (await get(`/panel/${robot.id}`, alex)).text();
        const card = page.indexOf('id="on-stream"');
        assert.ok(card > 0 && card < page.indexOf('Buttons'), 'the first owner card');
        assert.ok(page.includes(`action="/robots/${robot.id}/on-stream"`) && page.includes('Put the buttons under my OpenVibe.Live stream'));
        assert.ok(page.includes(`action="/robots/${robot.id}/access"`) && page.includes('<option value="private" selected>Only me and people I add</option>'));
        assert.ok(page.includes('Show the panel where it is embedded (your OpenVibe.Live stream)'), 'the embedding switch says where');
        assert.ok(!page.includes('Let anyone watch where it is embedded'));
        const other = await (await get(`/panel/${open.id}`, bob)).text();
        assert.ok(!other.includes('id="on-stream"'), 'only the owner sees it');
    });

    await check('"Put the buttons under my stream" shows the panel where embedded and opens the Live bind prompt', async () => {
        assert.strictEqual((await row(robot.id)).embed_public, false);
        const r = await post(`/robots/${robot.id}/on-stream`, alex, {});
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.get('location'), `https://openvibe.live/@alex?bind_robot=${robot.id}`);
        assert.strictEqual((await row(robot.id)).embed_public, true);
        assert.strictEqual((await post(`/robots/${robot.id}/on-stream`, bob, {})).status, 403, 'not the owner');
        assert.strictEqual((await post(`/robots/${robot.id}/on-stream`, alex, {}, { Origin: 'https://evil.example' })).status, 403, 'cross-site');
        const page = await (await get(`/panel/${robot.id}`, alex)).text();
        assert.ok(page.includes('class="setting-ok"'), 'the card says it is on');
    });

    await check('who may drive: the owner chooses it on the page', async () => {
        const r = await post(`/robots/${robot.id}/access`, alex, { access_policy: 'queue' });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.get('location'), `/panel/${robot.id}#on-stream`);
        assert.strictEqual((await row(robot.id)).access_policy, 'queue');
        assert.strictEqual((await post(`/robots/${robot.id}/access`, alex, { access_policy: 'everyone' })).status, 422);
        assert.strictEqual((await post(`/robots/${robot.id}/access`, bob, { access_policy: 'private' })).status, 403);
        await post(`/robots/${robot.id}/access`, alex, { access_policy: 'private' });
        assert.strictEqual((await row(robot.id)).access_policy, 'private');
    });

    await check('POST /api/v1/robots/:id/control-ticket: for a member or a queue robot, as the person; a ticket that drives', async () => {
        const forPerson = (id, user, cap = ['bot.robot.control']) => t.call('POST', `/api/v1/robots/${id}/control-ticket`, { cap, headers: user ? { 'X-OV-Subject': user.subject } : {} });
        const mine = await forPerson(robot.id, alex);
        assert.strictEqual(mine.status, 200, mine.text);
        assert.match(mine.json.ticket, /^[A-Za-z0-9_-]{43}$/);
        assert.deepStrictEqual([mine.json.robot_id, mine.json.role], [robot.id, 'owner']);
        assert.strictEqual(mine.headers.get('cache-control'), 'no-store');
        const stranger = await forPerson(robot.id, bob);
        assert.deepStrictEqual([stranger.status, stranger.json.code], [403, 'bot.not_an_operator'], 'a private robot');
        const queue = await forPerson(open.id, bob);
        assert.deepStrictEqual([queue.status, queue.json.role], [200, 'queue'], 'anyone signed in on a queue robot');
        assert.strictEqual((await forPerson(robot.id, alex, ['bot.robot.read'])).status, 403, 'needs bot.robot.control');
        assert.strictEqual((await forPerson(robot.id, null)).status, 422, 'a service must name the person');
        assert.strictEqual((await t.call('POST', `/api/v1/robots/${robot.id}/control-ticket`, { user: bob })).status, 403, 'a person asking for their own, on a private robot');
        // The ticket opens /control as that person.
        const ws = await t.ws('/control', { protocols: ['ov.ticket', `ov.ticket.${mine.json.ticket}`] });
        ws.send({ type: 'join', robot_id: robot.id });
        const joined = await ws.waitFor((m) => m.type === 'joined' || m.type === 'error');
        assert.deepStrictEqual([joined.type, joined.role], ['joined', 'owner'], JSON.stringify(joined));
        ws.close();
    });

    await check('the embedded panel asks its allowed page for a ticket; the refusal tells that page', () => {
        const SIM = { id: 'sim.rover', name: 'Rover', commands: { drive: { axes: { throttle: [-1, 1], steer: [-1, 1] } } }, widgets: [{ type: 'drive', label: 'Drive', command: { kind: 'drive' } }] };
        const html = renderPanel({ robot: { id: 'rob_d1', name: 'Rover', profile_id: 'sim.rover', estop: { latched: false } }, profile: SIM, role: 'watcher', mode: 'embed', signedIn: false, parentOrigins: ['https://openvibe.live', 'https://www.openvibe.live'] });
        assert.ok(html.includes('data-parent-origins="https://openvibe.live https://www.openvibe.live"'));
        const page = renderPanel({ robot: { id: 'rob_d1', name: 'Rover', profile_id: 'sim.rover', estop: { latched: false } }, profile: SIM, role: 'watcher', mode: 'page', parentOrigins: ['https://openvibe.live'] });
        assert.ok(!page.includes('data-parent-origins'), 'only a framed panel');
        const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.js'), 'utf8');
        assert.ok(js.includes("window.parent.postMessage({ type: 'ov-bot-ticket-request', robot_id: ROBOT_ID }, origin)"), 'asks each allowed origin only');
        assert.ok(js.includes('const fromParent = framed && e.source === window.parent && PARENTS.includes(e.origin);'), 'takes it from that page only');
        assert.ok(js.includes('const fromPopup = e.origin === location.origin && popup && e.source === popup;'), 'or from its own popup');
        const refused = renderEmbedRefused({ robotId: 'rob_d1', parentOrigins: ['https://openvibe.live'] });
        assert.ok(refused.includes('src="/panel/refused.js"') && refused.includes('data-parent-origins="https://openvibe.live"'));
        assert.ok(refused.includes('/panel/rob_d1#on-stream') && refused.includes('Put the buttons under my OpenVibe.Live stream'));
        const rjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'refused.js'), 'utf8');
        assert.ok(rjs.includes("window.parent.postMessage({ type: 'ov-bot-embed-refused', robot_id: robotId }, origin)"));
    });

    await check('/panel/refused.js is served', async () => {
        const r = await get('/panel/refused.js');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /javascript/);
    });

    await check('the camera mirror says it is video only', async () => {
        const page = await (await get(`/panel/${robot.id}`, alex)).text();
        assert.ok(page.includes("Send the robot&#39;s camera to my OpenVibe.Live channel") || page.includes("Send the robot's camera to my OpenVibe.Live channel"));
    });

    await t.close();
    done();
})();
