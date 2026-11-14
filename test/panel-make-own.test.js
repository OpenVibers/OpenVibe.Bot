'use strict';
// Make your own controls (plan §AB.50): the robot's owner gets a link beside Arrange that opens Codes with the robot's
// model and its parts as the brief, in the box and never sent by itself. An operator or a watcher does not get it, nor
// does an embed.
const assert = require('assert');
const { loadProfiles } = require('../server/profiles');
const { renderPanel } = require('../server/web/render');

const profile = loadProfiles().get('looi');
const robot = { id: 'rob_test', name: 'LOOI', profile_id: 'looi', online: true };
const draw = (role, mode = 'page') => renderPanel({ robot, profile, role, mode, allowed_commands: ['drive'], holdResendMs: 150 });

const owner = draw('owner');
const m = /<a class="arrange-btn make-btn" href="([^"]+)" target="_blank" rel="noopener"/.exec(owner);
assert.ok(m, 'the owner has Make your own');
const url = new URL(m[1].replace(/&amp;/g, '&'));
assert.strictEqual(url.origin, 'https://openvibe.codes');
const brief = url.searchParams.get('prompt');
assert.match(brief, /"LOOI"/, 'names the robot');
assert.match(brief, /profile looi/, 'and its profile');
assert.match(brief, /drive, head, battery, latency/, 'and its parts');
assert.ok(brief.length <= 1800, 'a brief, not a dump');
assert.ok(!/make-btn/.test(draw('operator')), 'not for an operator');
assert.ok(!/make-btn/.test(draw('watcher')), 'not for a watcher');
assert.ok(!/make-btn/.test(draw('owner', 'embed')), 'not in an embed');
console.log('panel-make-own: ok');
