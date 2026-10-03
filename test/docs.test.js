'use strict';
// The documentation contract (OpenVibe.Contracts scripts/docs-currency.js, roadmap WS-U task 3): the README
// states what the ecosystem needs to know about Bot, and STATUS.json matches the code in the same release.
// The Contracts check runs against this checkout; this test keeps the same rules green in Bot's own suite.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, done } = require('./helpers/app');

const ROOT = path.join(__dirname, '..');
const MANIFEST_REPOSITORY = 'OpenVibers/OpenVibe.Bot';
const STATUS_FIELDS = ['repository', 'stage', 'deployed', 'contracts', 'features', 'updated'];
// The sections docs-currency.js requires of every service README.
const REQUIRED = [
    ['Purpose', /^purpose\b|^what (it|this) is\b/i],
    ['Owns', /^owns\b/i],
    ['Does not own', /^does not own\b|^doesn't own\b/i],
    ['Depends on', /^depends on\b|^dependencies\b/i],
    ['Capabilities', /^capabilities\b|^grants\b|^principal\b/i],
    ['Acceptance', /^acceptance\b|^tests?\b|^testing\b/i],
    ['Security', /^security\b/i],
    ['Deploy', /^deploy|^deployment\b|^running it in production\b|^production\b/i],
];

(async () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const status = JSON.parse(fs.readFileSync(path.join(ROOT, 'STATUS.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    await check('the README has every section docs-currency.js requires', () => {
        const headings = readme.split('\n').filter((l) => /^##\s+/.test(l)).map((l) => l.replace(/^##\s+/, '').replace(/[`*_]/g, '').trim());
        for (const [label, re] of REQUIRED) assert.ok(headings.some((h) => re.test(h)), `README: no "## ${label}" section`);
    });

    await check('STATUS.json has the required fields and the manifest repository', () => {
        for (const f of STATUS_FIELDS) assert.ok(status[f] !== undefined, `STATUS.json: no "${f}"`);
        assert.strictEqual(status.repository, MANIFEST_REPOSITORY);
        assert.ok(status.features.length > 0, 'STATUS.json: features is empty');
    });

    await check('STATUS.json names the openvibe-contracts tag package.json pins', () => {
        const spec = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }['openvibe-contracts'];
        const m = /refs\/tags\/(v\d+\.\d+\.\d+)/.exec(spec) || /^\^?~?(\d+\.\d+\.\d+)$/.exec(spec);
        assert.ok(m, `package.json does not pin a tag for openvibe-contracts: ${spec}`);
        assert.ok(String(status.contracts).includes(m[1]), `STATUS.json: contracts "${status.contracts}", package.json pins ${m[1]}`);
    });

    await check('STATUS.json was refreshed with the newest package.json change', () => {
        let changed;
        try {
            changed = execFileSync('git', ['-C', ROOT, 'log', '-1', '--format=%cI', '--', 'package.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().slice(0, 10);
        } catch { changed = ''; }   // no git (a tarball): the Contracts check has the same limit
        if (changed) assert.ok(String(status.updated).slice(0, 10) >= changed, `STATUS.json: updated ${status.updated}, package.json changed ${changed}`);
    });

    done();
})();
