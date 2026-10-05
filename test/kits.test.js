'use strict';
// The kit catalogue (plan T15 "Get a robot", O29 metadata half): the shipped kits validate, every kit binds
// to a profile that ships, an invalid catalogue refuses at load, and GET /kits is a public read.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot, check, done } = require('./helpers/app');
const { loadKits, validateKit, list, get } = require('../server/kits');
const { loadProfiles } = require('../server/profiles');

// A minimal valid kit, cloned into the failure cases below.
const MINIMAL = {
    id: 'x.y', name: 'X', profile_id: 'sim.rover', build_guide_url: 'https://example.test/guide',
    parts: [{ name: 'A board' }],
};

(async () => {
    await check('the shipped kit catalogue loads, validates and binds every kit to a shipped profile', () => {
        const kits = loadKits();
        assert.deepStrictEqual([...kits.keys()], ['adeept.adr036']);
        const profiles = loadProfiles();
        for (const kit of kits.values()) {
            assert.ok(profiles.has(kit.profile_id), `${kit.id} binds a shipped profile`);
            assert.ok(kit.parts.length > 0, `${kit.id} has parts`);
            assert.match(kit.build_guide_url, /^https:\/\//);
        }
    });

    await check('the Adeept kit is the ADR036 car on adeept.adr036, with the parts you need and its build guide', () => {
        const kit = get('adeept.adr036');
        assert.strictEqual(kit.name, 'Adeept ADR036 4WD Smart Car Kit for Raspberry Pi');
        assert.strictEqual(kit.profile_id, 'adeept.adr036');
        assert.strictEqual(kit.vendor, 'Adeept');
        assert.match(kit.build_guide_url, /^https:\/\//);
        const names = kit.parts.map((p) => p.name).join('\n');
        assert.match(names, /Robot HAT/);
        assert.match(names, /Raspberry Pi/);
        assert.match(names, /microSD/);
        assert.match(names, /18650/);
        for (const p of kit.parts) {
            assert.ok(Number.isInteger(p.qty) && p.qty > 0, `${p.name} qty`);
            assert.strictEqual(typeof p.required, 'boolean', `${p.name} required`);
        }
        const pi = kit.parts.find((p) => /Raspberry Pi 4B or 5/.test(p.name));
        assert.match(pi.note, /not included/i, 'the kit does not include the Pi board');
        assert.strictEqual(list().length, 1, 'list() is the same catalogue the API serves');
        assert.strictEqual(get('nope'), null);
    });

    await check('qty defaults to 1 and required to true; a note is optional', () => {
        const kit = validateKit({ ...MINIMAL });
        assert.deepStrictEqual(kit.parts, [{ name: 'A board', qty: 1, required: true }]);
        const withNote = validateKit({ ...MINIMAL, parts: [{ name: 'A board', qty: 2, required: false, note: 'spare' }] });
        assert.deepStrictEqual(withNote.parts, [{ name: 'A board', qty: 2, required: false, note: 'spare' }]);
        assert.strictEqual(withNote.vendor, null);
        assert.strictEqual(withNote.description, null);
    });

    await check('a kit with a bad id, name, URL, parts or part is refused', () => {
        const refused = [
            [{ ...MINIMAL, id: 'Bad Id' }, /kit id is not valid/],
            [{ ...MINIMAL, id: undefined }, /kit id is not valid/],
            [{ ...MINIMAL, name: '   ' }, /name is required/],
            [{ ...MINIMAL, profile_id: undefined }, /profile_id is required/],
            [{ ...MINIMAL, build_guide_url: 'http://example.test/guide' }, /build_guide_url must be an https URL/],
            [{ ...MINIMAL, build_guide_url: 'javascript:alert(1)' }, /build_guide_url must be an https URL/],
            [{ ...MINIMAL, parts: [] }, /parts must be a non-empty array/],
            [{ ...MINIMAL, parts: [{ qty: 1 }] }, /\.name is required/],
            [{ ...MINIMAL, parts: [{ name: 'A board', qty: 0 }] }, /qty must be a positive integer/],
            [{ ...MINIMAL, parts: [{ name: 'A board', note: 'x'.repeat(201) }] }, /note must be at most/],
        ];
        for (const [kit, re] of refused) assert.throws(() => validateKit(kit), re, JSON.stringify(kit));
    });

    await check('a kit bound to a profile that does not ship is refused at load', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-kits-'));
        try {
            fs.writeFileSync(path.join(dir, 'orphan.json'), JSON.stringify({ ...MINIMAL, profile_id: 'does.not.exist' }));
            assert.throws(() => loadKits(dir), /is not a shipped profile/);
            // The shipped catalogue itself always passes the same check.
            assert.doesNotThrow(() => loadKits());
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    const t = await boot();
    await check('GET /api/v1/kits is a public read; an unknown kit is a problem+json 404', async () => {
        const all = await t.call('GET', '/api/v1/kits', { token: null });
        assert.strictEqual(all.status, 200);
        assert.deepStrictEqual(all.json.kits.map((k) => k.id), ['adeept.adr036']);
        const one = await t.call('GET', '/api/v1/kits/adeept.adr036', { token: null });
        assert.strictEqual(one.status, 200);
        assert.strictEqual(one.json.kit.profile_id, 'adeept.adr036');
        assert.ok(one.json.kit.parts.length > 0);
        const missing = await t.call('GET', '/api/v1/kits/nope', { token: null });
        assert.strictEqual(missing.status, 404);
        assert.strictEqual(missing.headers.get('content-type'), 'application/problem+json');
        assert.strictEqual(missing.json.code, 'bot.kit_not_found');
    });

    await check('the robots page offers "Get a robot": the kit, its parts, its guide and a start with its profile chosen', async () => {
        const alex = t.network.newUser('alex');
        const page = (q = '') => fetch(`${t.base}/robots${q}`, { redirect: 'manual', headers: { Cookie: `ov_token=${t.network.signUser(alex)}` } }).then((r) => r.text());
        const html = await page();
        assert.match(html, /<h2 id="kits-h">Get a robot<\/h2>/);
        assert.match(html, /Adeept ADR036 4WD Smart Car Kit for Raspberry Pi/);
        assert.match(html, /What you need/);
        assert.match(html, /href="https:\/\/www\.adeept\.com\/learn\/detail-97\.html" target="_blank" rel="noopener">Build guide/);
        assert.match(html, /href="\/robots\?profile=adeept\.adr036#add-robot">Add this robot/);
        assert.doesNotMatch(html, /\(O30\)/, 'no internal plan codes in public copy');
        assert.match(await page('?profile=adeept.adr036'), /<option value="adeept\.adr036" selected>/, 'the kit start chooses its profile');
        assert.doesNotMatch(await page('?profile=nope'), /<option value="nope"/);
    });
    await t.close();

    done();
})();
