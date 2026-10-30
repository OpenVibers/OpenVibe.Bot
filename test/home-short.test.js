'use strict';
// The front page on a phone (the owner's short-pages rule, 2026-10-30): the ways to connect are one pick block, a row
// of chips picks one of them, and the parts a reader rarely needs are folds. Radio inputs and :has(), no script for the
// chips; every block stays in the page for crawlers; a wider screen shows them all and no chips.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ openre: false });
    const get = (p) => fetch(t.base + p, { redirect: 'manual' });

    await check('GET /: the ways to connect are chips, the parts read once are folds', async () => {
        const r = await get('/');
        assert.strictEqual(r.status, 200);
        const html = await r.text();

        // The ways to connect: one pick block, a chip per way, the first one picked.
        assert.ok(html.includes('<div class="pick" id="pick-connect">'), 'the ways to connect are one pick block');
        assert.match(html, /<div class="pick-row" role="radiogroup" aria-label="The ways to connect">/);
        const chips = [...html.matchAll(/<input type="radio" name="pick-connect" id="pk-connect-([a-z-]+)" value="\1"( checked)?><label for="pk-connect-\1">([^<]+)<\/label>/g)];
        assert.ok(chips.length >= 3, 'a chip per way to connect');
        assert.deepStrictEqual(chips.filter((m) => m[2]).map((m) => m[1]), ['browser'], 'the first way is picked');
        assert.strictEqual((html.match(/class="pick-pane"/g) || []).length, chips.length, 'one pane per chip');
        // Every way stays in the page for the crawlers.
        for (const label of ['Simulated', 'A phone', 'On-board']) assert.ok(html.includes(`<strong>${label}</strong>`), `${label} is in the page`);
        // The rule that shows the picked way is written for this page.
        assert.ok(html.includes('.pick:has(#pk-connect-browser:checked) #pp-connect-browser{display:block}'), 'the picked way shows');

        // The folds: open in the page, closed on a phone, and their content stays in the page.
        for (const id of ['how', 'more', 'faq', 'network']) {
            assert.ok(html.includes(`<details class="hm-fold hm-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
            assert.ok(html.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
        }
        assert.ok(html.includes('Run one command on the robot'), 'the path online is still in the page');
        assert.ok(html.includes('What the panel does'), 'the parts read once are still in the page');
        assert.ok(html.includes('Do I need to open ports on my router?'), 'the questions are still in the page');
        assert.ok(html.includes('Part of OpenVibe'), 'the other OpenVibe places are still in the page');

        // The CSS guard: the chips are hidden and the blocks all show until 640 px and where :has() is understood.
        const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'home.css'), 'utf8');
        assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
        assert.match(css, /@supports selector\(:has\(\*\)\) \{ @media \(max-width: 640px\) \{/, 'the phone rules are under :has() and 640 px');
        assert.match(css, /\.pick-row label \{[^}]*min-height: 44px/, 'a chip is a 44 px target');
        assert.match(css, /\.pick-pane \{ display: none; \}/, 'the blocks are hidden on a phone');
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
