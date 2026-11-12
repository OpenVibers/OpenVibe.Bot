'use strict';
// A restart (a deploy) closes every socket with 1012 and waits for each client's close in reply before the process
// goes on to exit, so the device reads the code instead of a reset with no close frame (Maticus, 11-12). A client that
// never answers is dropped after the bound, and the stop goes on.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');

    async function device() {
        const { robot, pairing } = await t.robot(alex);
        const paired = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
        assert.strictEqual(paired.status, 201, paired.text);
        const dev = await t.ws('/device', { headers: { Authorization: `Bearer ${paired.json.credential}` } });
        await dev.waitFor((m) => m.type === 'config');
        return dev;
    }

    await check('a restart closes devices with 1012 and waits for their answer, bounded', async () => {
        const answering = await device();
        const silent = await device();
        // The silent one stops reading its socket, so it never sees the close frame and never answers.
        silent.ws._socket.pause();
        const started = Date.now();
        await t.hub.close();
        const took = Date.now() - started;
        assert.strictEqual(answering.ended, true, 'the answering device had closed by the time hub.close resolved');
        assert.strictEqual(answering.closeCode, 1012, `the device read 1012, not ${answering.closeCode}`);
        assert.ok(took >= 500 && took < 3000, `the silent device held the close for the bound only (${took} ms)`);
        silent.ws._socket.resume();
        const code = await silent.waitForClose(5000);
        assert.ok(code !== null, 'the silent device was dropped');
    });

    await t.close();
    done();
})();
