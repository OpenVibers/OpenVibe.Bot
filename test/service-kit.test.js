'use strict';
/**
 * Bot's shutdown moved onto openvibe-sdk/service (plan T1 lane A): main() hands the signal to gracefulStop,
 * whose stop steps keep the old hand-written order and whose close steps close the database. Bot's manifest
 * declares no lifecycle.shutdown deadline (OpenVibe.Contracts has no manifests/services/bot.json), so deadlineMs
 * is the kit's 5000 default — today's hard timer — and deadlineExitCode 0 keeps its exit 0.
 *
 * The first four checks read server/index.js itself (the entry point cannot be inspected through its exports
 * alone); the rest boot the real entry point with the same stubs the harness uses and drive the returned
 * shutdown with process.exit stubbed, so the stop steps can be observed in order and the database close seen.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { check, done } = require('./helpers/app');

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

(async () => {
    await check('server/index.js imports gracefulStop from openvibe-sdk/service', () => {
        const m = src.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"]openvibe-sdk\/service['"]\)/);
        assert.ok(m, "require('openvibe-sdk/service')'s exports are not destructured");
        assert.ok(/\bgracefulStop\b/.test(m[1]), 'gracefulStop is not imported');
    });

    await check('server/index.js leaves the signal handlers to the kit', () => {
        assert.ok(!/process\.on\(\s*['"]SIGTERM['"]/.test(src), 'server/index.js still installs its own SIGTERM handler');
        assert.ok(!/process\.on\(\s*['"]SIGINT['"]/.test(src), 'server/index.js still installs its own SIGINT handler');
        assert.ok(/gracefulStop\(\{/.test(src), 'gracefulStop is not called in main()');
    });

    await check("gracefulStop is named 'Bot' and keeps the old 5 s deadline and exit 0", () => {
        assert.ok(/name:\s*['"]Bot['"]/.test(src), "gracefulStop is not named 'Bot'");
        assert.ok(/drainMs:\s*4000/.test(src), 'drainMs is not 4000');
        assert.ok(/deadlineMs:\s*5000/.test(src), 'deadlineMs is not 5000');
        assert.ok(/deadlineExitCode:\s*0/.test(src), 'deadlineExitCode is not 0');
    });

    await check('hub.close stays a stop step before the HTTP drain; the database closes after it', () => {
        const stop = src.indexOf('() => hub.close()');
        const close = src.indexOf('() => db.close()');
        assert.ok(stop !== -1 && close !== -1, 'hub.close / db.close steps not found');
        assert.ok(stop < close, 'hub.close must be a stop step (before the drain and the close steps)');
    });

    // Boot the real entry point against the harness stubs; PORT=0 picks a free port and jobs are off. main()
    // reads process.env through loadConfig(), and with no DATABASE_URL it opens the development PGlite handle.
    const { startNetwork, startEvents } = require('./helpers/stubs');
    const network = await startNetwork();
    const events = await startEvents();
    Object.assign(process.env, {
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        BASE_URL: 'http://bot.test',
        BOT_JOBS: 'off',
        OV_NETWORK_URL: network.url,
        OV_NETWORK_INTERNAL_URL: network.url,
        OV_NETWORK_ISSUER: network.url,
        OV_OAUTH_CLIENT_ID: 'bot',
        OV_OAUTH_CLIENT_SECRET: 'shh',
        EVENTS_URL: events.url,
    });
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_DIRECT_URL;
    delete process.env.VALKEY_URL;

    let h = null;
    await check('main() boots and returns a shutdown handle', async () => {
        const { main } = require('../server/index');
        h = await main();
        assert.strictEqual(typeof h.shutdown, 'function', 'main() returned a shutdown function');
    });

    await check('the returned shutdown runs the stop steps in order and closes the database', async () => {
        if (!h) return;
        const order = [];
        const wrap = (obj, name, tag) => { const orig = obj[name].bind(obj); obj[name] = (...a) => { order.push(tag); return orig(...a); }; };
        wrap(h.app.locals.keys, 'stop', 'keys.stop');
        wrap(h.app.locals.hub, 'close', 'hub.close');
        wrap(h.app.locals.outbox, 'stop', 'outbox.stop');
        wrap(h.app.locals.db, 'close', 'db.close');

        const realExit = process.exit;
        let exitCode = null;
        process.exit = (code) => { exitCode = code; };
        let code;
        try { code = await h.shutdown(); } finally { process.exit = realExit; }

        assert.strictEqual(exitCode, 0, 'exit() is called with 0');
        assert.strictEqual(code, 0, 'the shutdown resolves with exit code 0');
        assert.strictEqual(h.server.listening, false, 'the HTTP server stops listening');
        assert.deepStrictEqual(order, ['keys.stop', 'hub.close', 'outbox.stop', 'db.close'],
            `the stop steps ran in the old order (saw ${order.join(', ')})`);

        // The kit starts the stop once: a second call is the same promise, no step runs again.
        const again = await h.shutdown();
        assert.strictEqual(again, 0, 'a second stop resolves with the same code');
        assert.strictEqual(order.length, 4, 'a second stop runs no step again');
    });

    await Promise.all([network.close(), events.close()]);
    done();
})();
