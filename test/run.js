#!/usr/bin/env node
/**
 * Runs every test in test/ — the files named *.test.js — each in its own process, and fails if any of
 * them fails. They use in-process stubs of OpenVibe.Network and OpenVibe.Events, temp databases and
 * random ports; none needs the network or a running service.
 *
 *   npm test                       # everything (PGlite)
 *   npm run test:pg                # everything on the containers (BOT_TEST_STORE=pg)
 *   npm test -- profiles pairing   # only files whose name contains one of the words
 */
'use strict';
// A file's wall timeout is generous: the test host is shared with other jobs, so a healthy file can take
// several times its usual time. Files still run one at a time (parallel: 1) to keep the host's load down.
require('openvibe-shared/test-runner').main({ dir: __dirname, timeoutMs: 180000, pad: 28, parallel: 1 });
