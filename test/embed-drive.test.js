'use strict';
// Driving from the embedded panel (plan T15 R9: a Live channel shows its robot's panel under the stream). The frame
// cannot see the openvibe.bot session (SameSite=Lax), so Drive opens a first-party popup that mints a one-time ticket
// (POST /panel/:id/ticket) and posts it to the frame; the frame opens /control offering it as a subprotocol.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { createControlTickets, ticketFromProtocols } = require('../server/control-tickets');
const { renderPanel } = require('../server/web/render');

(async () => {
    await check('tickets: single use, expire, never carry the ticket robot into the next; the protocol header parses strictly', () => {
        let at = 1000;
        const tk = createControlTickets({ now: () => at, ttlMs: 60_000 });
        const me = { kind: 'user', subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', username: 'alex', ticketRobot: 'rob_old' };
        const a = tk.issue(me, 'rob_1');
        assert.match(a.ticket, /^[A-Za-z0-9_-]{43}$/);
        assert.strictEqual(a.expires_in, 60);
        const r = tk.redeem(a.ticket);
        assert.strictEqual(r.robotId, 'rob_1');
        assert.strictEqual(r.principal.subject, me.subject);
        assert.strictEqual(r.principal.ticketRobot, undefined, 'a ticket-made principal does not carry the old binding');
        assert.strictEqual(tk.redeem(a.ticket), null, 'single use');
        const b = tk.issue(me, 'rob_1');
        at += 60_001;
        assert.strictEqual(tk.redeem(b.ticket), null, 'expired');
        assert.strictEqual(tk.issue({ kind: 'service', subject: me.subject }, 'rob_1'), null, 'people only');
        assert.strictEqual(ticketFromProtocols(`ov.ticket, ov.ticket.${a.ticket}`), a.ticket);
        assert.strictEqual(ticketFromProtocols(`ov.ticket.${a.ticket}`), null, 'the marker protocol is required');
        assert.strictEqual(ticketFromProtocols('ov.ticket, ov.ticket.short'), null);
        assert.strictEqual(ticketFromProtocols(''), null);
    });

    await check('the framed watcher gets a Drive button and a hidden e-stop; the client takes tickets from its own popup only', () => {
        const SIM = { id: 'sim.rover', name: 'Rover', commands: { drive: { axes: { throttle: [-1, 1], steer: [-1, 1] } } }, widgets: [{ type: 'drive', label: 'Drive', command: { kind: 'drive' } }] };
        const html = renderPanel({ robot: { id: 'rob_d1', name: 'Rover', profile_id: 'sim.rover', estop: { latched: false } }, profile: SIM, role: 'watcher', allowed_commands: [], mode: 'embed', signedIn: false });
        assert.ok(html.includes('data-drive>') && html.includes('data-drive-bar'));
        assert.ok(html.includes('data-estop hidden>'), 'the e-stop waits for an owner or operator join');
        const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.js'), 'utf8');
        // Only its own popup, or the allowed page around the frame (stream-buttons.test.js), hands it a ticket.
        assert.match(js, /const fromPopup = e\.origin === location\.origin && popup && e\.source === popup;/);
        assert.match(js, /if \(!fromPopup && !fromParent\) return;/);
        assert.match(js, /new WebSocket\(wsUrl\(path\), \['ov\.ticket', `ov\.ticket\.\$\{ticket\}`\]\)/);
        assert.match(js, /\$\('\[data-estop\]:not\(\[hidden\]\)'\)\) estop\(\);/, 'a gamepad never e-stops through a hidden button');
        const popupJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'drive.js'), 'utf8');
        assert.match(popupJs, /window\.opener\.postMessage\(\{ type: 'ov-bot-ticket', robot_id: robotId, ticket: body\.ticket \}, location\.origin\)/);
    });

    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const cookie = (user) => `ov_token=${t.network.signUser(user)}`;
    const mint = (robotId, user, headers = {}) => fetch(`${t.base}/panel/${robotId}/ticket`, {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...(user ? { Cookie: cookie(user) } : {}), ...headers },
        body: '{}',
    });
    const withTicket = (ticket) => t.ws('/control', { protocols: ['ov.ticket', `ov.ticket.${ticket}`] });

    const { robot: mine } = await t.robot(alex, { name: 'Desk rover' });
    const { robot: other } = await t.robot(alex, { name: 'Other rover' });
    const { robot: open } = await t.robot(alex, { name: 'Queue rover', access_policy: 'queue' });

    await check('POST /panel/:id/ticket: a member gets a ticket; cross-site, signed-out and no-access calls are refused', async () => {
        const r = await mint(mine.id, alex);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        const j = await r.json();
        assert.match(j.ticket, /^[A-Za-z0-9_-]{43}$/);
        assert.strictEqual(j.robot_id, mine.id);
        assert.strictEqual((await mint(mine.id, alex, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
        assert.strictEqual((await mint(mine.id, alex, { Origin: 'https://evil.example' })).status, 403);
        assert.strictEqual((await mint(mine.id, null)).status, 401);
        assert.strictEqual((await mint(mine.id, bob)).status, 403, 'a stranger on a private robot');
        assert.strictEqual((await mint(open.id, bob)).status, 200, 'anyone signed in may queue for a queue robot');
        assert.strictEqual((await mint('rob_nothing', alex)).status, 404);
    });

    await check('GET /panel/:id/drive: the popup page for a member; sign in first otherwise', async () => {
        const page = await fetch(`${t.base}/panel/${mine.id}/drive`, { redirect: 'manual', headers: { Cookie: cookie(alex) } });
        assert.strictEqual(page.status, 200);
        const html = await page.text();
        assert.ok(html.includes('data-drive-page') && html.includes(`data-robot-id="${mine.id}"`) && html.includes('/panel/drive.js'));
        const out = await fetch(`${t.base}/panel/${mine.id}/drive`, { redirect: 'manual' });
        // A gated page answers here with noindex (SEO-7), not a redirect off the site.
        assert.strictEqual(out.status, 401);
        assert.match(await out.text(), /name="robots" content="noindex, nofollow"/);
        assert.strictEqual((await fetch(`${t.base}/panel/${mine.id}/drive`, { redirect: 'manual', headers: { Cookie: cookie(bob) } })).status, 403);
        assert.strictEqual((await fetch(`${t.base}/panel/drive.js`)).status, 200);
    });

    await check('/control with a ticket: the person\'s own role, the next ticket on join, one robot only, and spent tickets refused', async () => {
        const { ticket } = await (await mint(mine.id, alex)).json();
        const op = await withTicket(ticket);
        assert.strictEqual(op.ws.protocol, 'ov.ticket', 'the server answers the ticket protocol');
        op.send({ type: 'join', robot_id: mine.id });
        const joined = await op.waitFor((m) => m.type === 'joined');
        assert.strictEqual(joined.role, 'owner');
        assert.ok(joined.allowed_commands.includes('drive'));
        assert.match(joined.ticket, /^[A-Za-z0-9_-]{43}$/, 'the reconnect ticket');
        assert.notStrictEqual(joined.ticket, ticket);
        op.send({ type: 'join', robot_id: other.id });
        const refused = await op.waitFor((m) => m.type === 'error');
        assert.strictEqual(refused.code, 'bot.forbidden', 'a ticket is for one robot');
        op.close();
        // The spent ticket opens nothing; the reconnect ticket does, once.
        const spent = await withTicket(ticket);
        assert.strictEqual(await spent.waitForClose(), 4002);
        const again = await withTicket(joined.ticket);
        again.send({ type: 'join', robot_id: mine.id });
        assert.strictEqual((await again.waitFor((m) => m.type === 'joined')).role, 'owner');
        again.close();
        const twice = await withTicket(joined.ticket);
        assert.strictEqual(await twice.waitForClose(), 4002);
    });

    await check('a queue robot: a stranger\'s ticket joins the queue like the page does', async () => {
        const { ticket } = await (await mint(open.id, bob)).json();
        const op = await withTicket(ticket);
        op.send({ type: 'join', robot_id: open.id });
        assert.strictEqual((await op.waitFor((m) => m.type === 'joined')).role, 'queue');
        op.close();
    });

    await done(t);
})();
