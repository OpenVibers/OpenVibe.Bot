'use strict';

/**
 * The non-API surface: a one-line text placeholder at `/` for the health of the process (the panel and
 * the site are designed separately), and nothing else. No pages, no CSS, no copy beyond this.
 */
const express = require('express');
const VERSION = require('../../package.json').version;

function createWebRoutes() {
    const r = express.Router();
    r.get('/', (req, res) => res.type('text/plain').send(`OpenVibe.Bot ${VERSION} — ok (devices, pairing and control; API under /api/v1)\n`));
    r.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
    return r;
}

module.exports = { createWebRoutes };
