'use strict';
// A robot from a blank microSD card (owner 2026-10-24: "if you just have a fresh MicroSD card … the site needs to guide
// the user … now I can't even enter that command"). /setup/sd-card makes the card's first-boot files in the browser
// with a setup key (server/setup-keys.js); the card's first boot runs the installer with it and the claim is approved
// at once, with the choices made with the files: no code on a screen, nothing typed on the robot.
const assert = require('assert');
const { execFileSync } = require('child_process');
const { boot, check, done } = require('./helpers/app');
const card = require('../public/sd-card');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const get = (p, user, headers = {}) => fetch(t.base + p, { redirect: 'manual', headers: { ...(user ? cookie(user) : {}), ...headers } });
    const postJson = (p, user, body, headers = {}) => fetch(t.base + p, {
        method: 'POST', redirect: 'manual', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(user ? cookie(user) : {}), ...headers },
    });
    const start = (body) => t.call('POST', '/api/v1/claims', { token: null, body });
    const poll = (c) => t.call('GET', `/api/v1/claims/${c.id}`, { token: null, headers: { 'X-OV-Claim-Secret': c.secret } });
    const pi = { hostname: 'mecanum', hardware: { model: 'Raspberry Pi 4 Model B Rev 1.5', os: 'Debian GNU/Linux 13 (trixie)', arch: 'aarch64' } };
    const choices = { name: 'Mecanum rover', profile_id: 'adeept.adr036.mecanum', access_policy: 'invite', live: true, hostname: 'mecanum' };
    let made, robotId, firstCode;

    await check('the page: the steps for anyone, the form once signed in, the model asked for chosen', async () => {
        const anon = await (await get('/setup/sd-card')).text();
        assert.ok(anon.includes('A robot from a blank microSD card') && anon.includes('Raspberry Pi OS Lite (64-bit)') && anon.includes('bootfs'));
        assert.ok(anon.includes('href="/auth/login?next=%2Fsetup%2Fsd-card"') && !anon.includes('id="sd-form"'), 'signed out: a sign-in, no form');
        const html = await (await get('/setup/sd-card?profile=adeept.adr036.mecanum', alex)).text();
        assert.ok(html.includes('id="sd-form"') && html.includes('<script src="/panel/sd-card.js" defer></script>'));
        assert.match(html, /<option value="adeept\.adr036\.mecanum" selected>/);
        assert.ok(!/name="wifi_password"[^>]*value=/.test(html), 'no password ever comes from the server');
        const js = await get('/panel/sd-card.js');
        assert.strictEqual(js.status, 200);
        assert.match(js.headers.get('content-type'), /javascript/);
        const add = await (await get('/robots/new', alex)).text();
        assert.ok(add.includes('href="/setup/sd-card"'), 'Add a robot points at it');
        const robots = await (await get('/robots.txt')).text();
        assert.ok(robots.includes('Disallow: /setup/sd-card/keys') && !robots.includes('Disallow: /setup/sd-card\n'));
    });

    await check('making the files: signed in, from this site, a listed model; the answer is a key shown once', async () => {
        assert.strictEqual((await postJson('/setup/sd-card/keys', null, choices)).status, 401);
        assert.strictEqual((await postJson('/setup/sd-card/keys', alex, choices, { Origin: 'https://evil.test' })).status, 403);
        const bad = await postJson('/setup/sd-card/keys', alex, { ...choices, profile_id: 'no.such' });
        assert.strictEqual(bad.status, 422);
        assert.strictEqual((await bad.json()).error, 'bot.unknown_profile');
        assert.strictEqual((await postJson('/setup/sd-card/keys', alex, { ...choices, hostname: 'Not A Host!' })).status, 422);
        const r = await postJson('/setup/sd-card/keys', alex, choices);
        assert.strictEqual(r.status, 201);
        made = await r.json();
        assert.match(made.id, /^osk_[0-9A-Z]{26}$/);
        assert.match(made.key, /^osk_[A-Za-z0-9_-]{43}$/);
        const row = await t.db.maybe('SELECT * FROM device_setup_keys WHERE id = $1', [made.id]);
        assert.ok(row.secret_hash !== made.key && !JSON.stringify(row).includes(made.key), 'only the hash is kept');
        assert.ok(new Date(made.expires_at).getTime() - Date.now() > 6.9 * 24 * 3600 * 1000, 'it lasts 7 days');
        const s = await (await get(`/setup/sd-card/keys/${made.id}`, alex)).json();
        assert.deepStrictEqual([s.state, s.name, s.hostname, s.robot_id], ['waiting', 'Mecanum rover', 'mecanum', null]);
        assert.strictEqual((await get(`/setup/sd-card/keys/${made.id}`, bob)).status, 404, 'only its owner follows it');
    });

    await check('first boot: the claim is approved at once with the card\'s choices, no code on a screen', async () => {
        const r = await start({ ...pi, setup_key: made.key });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.approved, true);
        const p = await poll(r.json);
        assert.strictEqual(p.json.state, 'approved');
        assert.deepStrictEqual([p.json.name, p.json.profile_id, p.json.driver, p.json.live], ['Mecanum rover', 'adeept.adr036.mecanum', 'adeept-mecanum', true]);
        robotId = p.json.robot_id;
        firstCode = p.json.pairing.code;
        const robot = await t.db.maybe('SELECT owner_subject, access_policy FROM robots WHERE id = $1', [robotId]);
        assert.deepStrictEqual([robot.owner_subject, robot.access_policy], [alex.subject, 'invite'], 'alex\'s robot, as chosen');
        const s = await (await get(`/setup/sd-card/keys/${made.id}`, alex)).json();
        assert.deepStrictEqual([s.state, s.robot_id], ['installing', robotId]);
    });

    await check('a retry before pairing (the install stopped half way) pairs the same robot with a fresh code', async () => {
        const r = await start({ ...pi, setup_key: made.key });
        assert.strictEqual(r.status, 201, r.text);
        const p = await poll(r.json);
        assert.strictEqual(p.json.robot_id, robotId, 'no second robot');
        assert.notStrictEqual(p.json.pairing.code, firstCode, 'a fresh code (the first may have run out)');
        assert.strictEqual(Number((await t.db.maybe('SELECT COUNT(*) AS n FROM robots WHERE owner_subject = $1', [alex.subject])).n), 1);
        const paired = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robotId, code: p.json.pairing.code, device_kind: 'onboard', name: 'mecanum' } });
        assert.strictEqual(paired.status, 201, paired.text);
        const s = await (await get(`/setup/sd-card/keys/${made.id}`, alex)).json();
        assert.strictEqual(s.state, 'paired');
    });

    await check('a spent, revoked, expired or made-up key adds nothing, and says what to do', async () => {
        const spent = await start({ ...pi, setup_key: made.key });
        assert.strictEqual(spent.status, 403);
        assert.strictEqual(spent.json.code, 'bot.setup_key_invalid');
        assert.match(spent.json.detail || spent.json.error, /setup\/sd-card/);
        const other = await (await postJson('/setup/sd-card/keys', bob, { ...choices, name: 'Bob bot' })).json();
        assert.strictEqual((await postJson(`/setup/sd-card/keys/${other.id}/revoke`, alex, {})).status, 404, 'not alex\'s to revoke');
        assert.strictEqual((await postJson(`/setup/sd-card/keys/${other.id}/revoke`, bob, {})).status, 200);
        assert.strictEqual((await start({ ...pi, setup_key: other.key })).status, 403);
        const old = await (await postJson('/setup/sd-card/keys', bob, { ...choices, name: 'Old bot' })).json();
        await t.db.query("UPDATE device_setup_keys SET expires_at = now() - interval '1 minute' WHERE id = $1", [old.id]);
        assert.strictEqual((await start({ ...pi, setup_key: old.key })).status, 403);
        assert.strictEqual((await (await get(`/setup/sd-card/keys/${old.id}`, bob)).json()).state, 'expired');
        assert.strictEqual((await start({ ...pi, setup_key: 'osk_' + 'x'.repeat(43) })).status, 403);
    });

    await check('the card files: SHA-512 crypt as openssl makes it, YAML that says exactly what was typed', async () => {
        for (const [pw, salt] of [['hunter2', 'saltsaltsaltsalt'], ['pässwörd "q" \\ & more', 'abc'], ['x'.repeat(70), 'Zz9./AbCdEfGhIj']]) {
            let ref = null;
            try { ref = execFileSync('openssl', ['passwd', '-6', '-salt', salt, pw]).toString().trim(); } catch { ref = null; }
            const mine = await card.sha512Crypt(pw, salt);
            if (ref) assert.strictEqual(mine, ref, `crypt of ${JSON.stringify(pw)}`);
            assert.match(mine, new RegExp(`^\\$6\\$${salt.replace(/[.$]/g, '\\$&')}\\$[./0-9A-Za-z]{86}$`));
        }
        assert.strictEqual(card.yamlQuote('a "b" \\ c\td'), '"a \\"b\\" \\\\ c\\x09d"');
        const ud = card.userData({ hostname: 'mecanum', username: 'robot', passwordHash: '$6$abc$xyz', sshKeys: ['ssh-ed25519 AAAA you@x', ''], timezone: 'America/Los_Angeles',
            setupKey: made.key, server: 'https://openvibe.bot', robotName: 'Mecanum rover' });
        assert.ok(ud.startsWith('#cloud-config\n'), 'cloud-init reads only a file that starts with #cloud-config');
        assert.ok(ud.includes(`  content: "${made.key}"`) && ud.includes('/etc/openvibe/setup-key') && ud.includes('permissions: "0600"'));
        assert.ok(ud.includes('curl -fsSL https://openvibe.bot/install | sh -s -- --setup "$key"'));
        assert.ok(ud.includes('  - [ systemctl, enable, --now, ssh ]') && ud.includes('systemd-run, --unit=openvibe-setup'));
        assert.ok(/\nruncmd:\n/.test(ud) && ud.split('\nruncmd:').length === 2, 'one runcmd list (a second would replace the first)');
        assert.throws(() => card.userData({ hostname: 'x', username: 'y', passwordHash: 'z', setupKey: 'nope' }), /setup key/);
        const nc = card.networkConfig({ ssid: 'Home "5G": café', password: 'p@ss "w" \\', country: 'us', hidden: true });
        assert.ok(nc.includes('regulatory-domain: "US"') && nc.includes('        "Home \\"5G\\": café":') && nc.includes('          hidden: true')
            && nc.includes('          password: "p@ss \\"w\\" \\\\"'));
        assert.ok(card.networkConfig({ ssid: 'Cafe', country: 'GB' }).includes('key-management: none'), 'an open network');
    });

    await t.close();
    done();
})();
