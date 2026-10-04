'use strict';

/**
 * The non-API surface: a one-line text placeholder at `/` for the health of the process, `/install`, a 302 to
 * OpenVibe.Node's installer script (the one-paste command, ADR-043), and the signed-in pages (the five-minute
 * path and the profile-rendered panel, plan T15 step 3):
 *
 *   GET  /robots           the signed-in person's robots and the "add a robot" form
 *   POST /robots           add one (form post) → 303 to its panel (a `sim` robot) or its pairing page
 *   GET  /pair/:id         the owner only: a fresh pairing code and the installer command
 *   GET  /panel/:id        a member (or anyone on a `queue` robot): the panel, rendered from the profile
 *   GET  /panel/panel.js, /panel/panel.css   the panel client and its sheet (public/, no build step)
 *
 * Not signed in → 302 to /auth/login?next=<the page>. No access → 403 (bot.not_an_operator / bot.forbidden).
 * Pages are never cached: a pairing page carries a live code.
 */
const path = require('path');
const express = require('express');
const { getProfile, listProfiles } = require('../profiles');
const { BotError } = require('../util');
const { renderPanel, renderRobotsPage, renderPairingPage } = require('./render');
const VERSION = require('../../package.json').version;

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const HOLD_RESEND_MS = 150;

function createWebRoutes(config, { domain = null, sim = null, log = console } = {}) {
    const r = express.Router();
    r.get('/', (req, res) => res.type('text/plain').send(`OpenVibe.Bot ${VERSION} — ok (devices, pairing and control; API under /api/v1)\n`));
    r.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
    // `curl -fsSL` follows the redirect. The target is config only (checked at boot): no query parameter steers it.
    r.get('/install', (req, res) => res.redirect(302, config.installer.sourceUrl));
    if (!domain) return r;

    const asset = (file, type) => (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.type(type).sendFile(path.join(PUBLIC, file)); };
    r.get('/panel/panel.js', asset('panel.js', 'application/javascript'));
    r.get('/panel/panel.css', asset('panel.css', 'text/css'));

    const requireUser = (req) => {
        if (!req.viewer) throw new BotError(401, 'bot.sign_in', 'sign in first');
        return req.viewer;
    };
    const profileOf = async (robot) => {
        const row = await getProfile(domain.db, robot.profile_id, robot.profile_version);
        return row ? row.profile : null;
    };
    const startSim = (robot) => (sim ? sim.attach(robot).catch((e) => { log.warn(`[Bot] simulator for ${robot.id}: ${e.message}`); return false; }) : Promise.resolve(false));
    /** A page handler: 401 → sign in and come back, 403/404 → a plain answer, anything else → the app's 500. */
    const page = (fn) => async (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        try { await fn(req, res); } catch (e) {
            if (e.status === 401) return res.redirect(302, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
            if (e.status === 403 || e.status === 404) return res.status(e.status).type('text/plain').send(`${e.detail || e.code}\n`);
            return next(e);
        }
        return undefined;
    };
    // A form post must come from this site (the session cookie is SameSite=Lax; this is the second fence).
    const sameOrigin = (req) => {
        const origin = req.headers.origin;
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin || new URL(origin).host === req.headers.host; } catch { return false; }
    };

    async function robotsPage(req, res, me, extra = {}) {
        const robots = (await domain.robots.list(me.subject)).map(domain.present.robot);
        const profiles = (await listProfiles(domain.db)).map((p) => p.profile);
        res.type('html').send(renderRobotsPage({ robots, profiles, ...extra }));
    }

    r.get('/robots', page(async (req, res) => robotsPage(req, res, requireUser(req))));

    r.post('/robots', express.urlencoded({ extended: false, limit: '8kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const body = req.body || {};
        const values = { name: typeof body.name === 'string' ? body.name : '', profile_id: String(body.profile_id || ''), access_policy: String(body.access_policy || 'private') };
        let robot;
        try {
            ({ robot } = await domain.robots.create({ owner: me.subject, name: values.name, profile_id: values.profile_id, access_policy: values.access_policy }));
        } catch (e) {
            if (e.status === 422) { res.status(422); return robotsPage(req, res, me, { error: e.detail || e.code, values }); }
            throw e;
        }
        // A simulated robot needs no machine: straight to its panel.
        return res.redirect(303, (await startSim(robot)) ? `/panel/${robot.id}` : `/pair/${robot.id}`);
    }));

    r.get('/pair/:id', page(async (req, res) => {
        const me = requireUser(req);
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        if (robot.owner_subject !== me.subject) throw new BotError(403, 'bot.forbidden', 'only the owner may pair a device');
        const pairing = await domain.pairing.create(robot.id, me.subject, undefined, robot);
        res.type('html').send(renderPairingPage({ robot: domain.present.robot(robot), pairing, profile: await profileOf(robot) }));
    }));

    r.get('/panel/:id', page(async (req, res) => {
        const me = requireUser(req);
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        // As the /control join decides: a member's role, or a place in the queue on a `queue` robot.
        let role = await domain.members.roleOf(robot.id, me.subject);
        if (!role && robot.access_policy === 'queue') role = 'queue';
        if (!role) throw new BotError(403, 'bot.not_an_operator', 'you have no access to this robot');
        const profile = await profileOf(robot);
        if (!profile) throw new BotError(404, 'bot.profile_not_found', 'this robot has no profile');
        await startSim(robot);
        const { maxCommandMs } = domain.control.effectiveLimits(robot, profile);
        res.type('html').send(renderPanel({
            robot: domain.present.robot(robot), profile, role,
            allowed_commands: domain.control.allowedFor(robot, role, profile),
            // A held control is re-sent well inside the device's deadline, so it never stops between two frames.
            holdResendMs: Math.max(50, Math.min(HOLD_RESEND_MS, Math.floor(maxCommandMs / 2))),
        }));
    }));

    return r;
}

module.exports = { createWebRoutes };
