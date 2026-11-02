'use strict';
// The front page on a phone (the owner's short-pages rule, 2026-10-31): the ways to connect are all shown, stacked,
// and the chips are links that jump to a way. No content is hidden; the parts a reader rarely needs are folds.
// Every block stays in the page for crawlers; a wider screen shows no chips.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ openre: false });
    const get = (p) => fetch(t.base + p, { redirect: 'manual' });

    await check('GET /: the ways to connect are linked chips over every way; the parts read once are folds', async () => {
        const r = await get('/');
        assert.strictEqual(r.status, 200);
        const html = await r.text();

        // The ways to connect: one pick block, a chip link per way, every way in the page.
        assert.ok(html.includes('<div class="pick" id="pick-connect">'), 'the ways to connect are one pick block');
        assert.match(html, /<nav class="pick-row" aria-label="The ways to connect">/);
        const paneIds = [...html.matchAll(/<div class="pick-pane" id="(pp-connect-[a-z-]+)">/g)].map((m) => m[1]);
        const chips = [...html.matchAll(/<a class="pick-chip" href="#(pp-connect-[a-z-]+)">([^<]+)<\/a>/g)];
        assert.ok(chips.length >= 3, 'a chip per way to connect');
        assert.deepStrictEqual(chips.map((m) => m[1]), paneIds, 'one chip per pane, in the same order');
        // Every way stays in the page for the crawlers.
        for (const label of ['Simulated', 'A phone', 'On-board']) assert.ok(html.includes(`<strong>${label}</strong>`), `${label} is in the page`);
        // The chips are links, not radios, and their targets exist in the page.
        const pick = html.slice(html.indexOf('<div class="pick" id="pick-connect">'), html.indexOf('</section>', html.indexOf('<div class="pick" id="pick-connect">')));
        assert.ok(!/type="radio"/.test(pick), 'no radio input inside the pick block');
        assert.ok(!/pickRule|pk-connect/.test(html), 'no inline rule that shows one picked pane');
        for (const m of chips) assert.ok(html.includes(`id="${m[1]}"`), `the pane ${m[1]} exists`);

        // The folds: open in the page, closed on a phone, and their content stays in the page.
        for (const id of ['how', 'more', 'faq', 'network']) {
            assert.ok(html.includes(`<details class="hm-fold hm-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
            assert.ok(html.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
        }
        assert.ok(html.includes('Run one command on the robot'), 'the path online is still in the page');
        assert.ok(html.includes('What the panel does'), 'the parts read once are still in the page');
        assert.ok(html.includes('Do I need to open ports on my router?'), 'the questions are still in the page');
        assert.ok(html.includes('Part of OpenVibe'), 'the other OpenVibe places are still in the page');

        // The stylesheet: the chips are a wide-screen no-show, shown on a phone as links; nothing hides a pane.
        const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'home.css'), 'utf8');
        assert.match(css, /\.pick-head, \.pick-row \{ display: none; \}/, 'the chips are hidden by default');
        assert.match(css, /@media \(max-width: 640px\) \{/, 'the phone rules are under 640 px');
        assert.match(css, /\.pick-chip \{[^}]*min-height: 44px/, 'a chip is a 44 px target');
        assert.ok(!/\.pick-pane[^{]*\{[^}]*display:\s*none/.test(css), 'no rule hides a pane');
        assert.ok(!/\.pick[^,{]*:has\(/.test(css), 'no picked-pane rule');
        assert.match(css, /\.hm-sec#connect \.pick-head \{ display: none; \}/, 'the connect section keeps one heading, not a duplicate');
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
