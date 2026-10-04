'use strict';

/**
 * The non-API surface: a one-line text placeholder at `/` for the health of the process (the panel and
 * the site are designed separately), and `/install`, a 302 to OpenVibe.Node's installer script (the
 * one-paste command, ADR-043). No pages, no CSS, no copy beyond this.
 */
const express = require('express');
const VERSION = require('../../package.json').version;

function createWebRoutes(config) {
    const r = express.Router();
    r.get('/', (req, res) => res.type('text/plain').send(`OpenVibe.Bot ${VERSION} — ok (devices, pairing and control; API under /api/v1)\n`));
    r.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
    // `curl -fsSL` follows the redirect. The target is config only (checked at boot): no query parameter steers it.
    r.get('/install', (req, res) => res.redirect(302, config.installer.sourceUrl));
    return r;
}

module.exports = { createWebRoutes };
