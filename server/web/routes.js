'use strict';

/**
 * The non-API surface: the front page at `/` (web/home.js), `/robots.txt`, `/sitemap.xml`, `/llms.txt`,
 * `/llms-full.txt`, `/manifest.webmanifest`, `/install`, a 302 to OpenVibe.Node's installer script (the one-paste command,
 * ADR-043), and the signed-in pages (the five-minute path and the profile-rendered panel, plan T15 step 3):
 *
 *   GET  /robots           the signed-in person's robots and the "add a robot" form
 *   POST /robots           add one (form post) → 303 to its panel (a `sim` robot), else 201 with its pairing page
 *   GET  /pair/:id         the owner only: a fresh pairing code and the installer command (never minted for a
 *                          cross-site navigation or a prefetch: those go to /robots)
 *   GET  /panel/:id        a member (or anyone on a `queue` robot): the panel, rendered from the profile
 *   GET  /panel/:id/embed  the panel for a frame (plan T15 R9): a signed-in member's role as /panel/:id decides it,
 *                          otherwise `watcher` (video and readouts, no control) when the owner allows embedding,
 *                          otherwise 403 with a link out. Never redirects to sign in; framed only by the
 *                          BOT_EMBED_ORIGINS allow-list (CSP frame-ancestors), every other page by itself
 *   POST /robots/:id/embed the owner only: allow (embed_public=on) or stop (off) anonymous read-only embedding → 303 to its panel
 *   POST /robots/:id/operators            the owner only: add a person by @username with a role → 303 to its panel
 *   POST /robots/:id/operators/:subject/remove   the owner only: remove a person (never the owner row) → 303
 *   POST /robots/:id/queue/leave          any signed-in person: leave the robot's turn queue → 303
 *   GET  /panel/panel.js, /panel/panel.css   the panel client and its sheet (public/, no build step)
 *
 * The panel and embed pages carry their own CSP (PANEL_CSP / embedCsp): the live camera plays the robot's
 * OpenRestream WebRTC session with the pinned mediasoup-client ESM build from esm.sh, so those two pages alone
 * allow that script origin and OpenRestream's signaling; the rest of the site keeps `default-src 'self'`.
 *
 * Not signed in → 302 to /auth/login?next=<the page>. No access → 403 (bot.not_an_operator / bot.forbidden).
 * Pages are never cached: a pairing page carries a live code. Adding a robot and minting a code count against
 * the signed-in person's `bot.robot.manage` limit, the same one /api/v1 applies.
 */
const path = require('path');
const express = require('express');
const seo = require('openvibe-shared/seo');
const appIcon = require('openvibe-shared/app-icon');
const { getProfile, listProfiles, loadProfiles } = require('../profiles');
const { frameAncestors } = require('../config');
const { BotError } = require('../util');
const kits = require('../kits');
const { renderPanel, renderEmbedRefused, renderDrivePage, renderPairingPage, renderPhonePage, renderMachinesPage, renderMachineScreenPage, renderSharePage, renderShareGone, renderLinkPage, renderClaimPage, renderClaimApproved } = require('./render');
const { createMachineScreen } = require('../machine-screen');
const { createScreenShares } = require('../screen-shares');
const { renderDocsIndex, renderDriversPage, renderProfilesPage, renderAutomationPage, renderComputersPage } = require('./docs');
const { renderSdCard } = require('./sd-card');
const { checkProfile } = require('../profiles');
const { renderHome, renderUpdates, HOME_CSP } = require('./home');
const { renderDirectory, renderModels, renderModel, renderRobotPage, renderAddRobot, renderSubmit, renderSubmissions, modelOf, sortModels } = require('./directory');
const { createNetworkReads } = require('./network-reads');
const { LICENSES } = require('../submissions');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const HOLD_RESEND_MS = 150;
// The rover /try drives, as shipped (server/profiles/sim.rover.json, validated).
const TRY_PROFILE = loadProfiles().get('sim.rover');
// The tagline stated for openvibe.bot (openvibe-contracts manifests/services/bot.json site.tagline).
const SITE_TAGLINE = 'An open control panel for robots';
// Every public GET page, for the sitemap. The interactive pages (/robots, /pair/, /panel/) need a session and
// are Disallowed in robots.txt; the API and sign-in are not pages, and neither is /install (a 302 to the installer
// script: a sitemap that lists a redirect wastes the crawl on it).
const PUBLIC_PAGES = ['/', '/try', '/robots', '/models', '/docs', '/docs/drivers', '/docs/profiles', '/docs/automation', '/docs/computers', '/updates', '/terms', '/privacy', '/dmca'];
// The public pages an AI crawler can read, for /llms.txt and /llms-full.txt (llmstxt.org). Same pages as the
// sitemap minus /install (a 302 to the installer script, not a page); no signed-in or per-robot page, nothing
// under the API or /internal. `note` is the one-line llms.txt entry, `text` the page's full text in llms-full.txt,
// written from what the page and its renderer actually say (README "Owns", web/home.js, web/docs.js, shared/legal).
const LLMS_NAME = 'OpenVibe.Bot';
const LLMS_SUMMARY = 'An open control panel for robots: pair a robot with one pasted command and drive it from any '
    + 'browser, with roles, limits and a latched emergency stop on every command.';
const LLMS_PAGES = [
    {
        path: '/', title: 'OpenVibe.Bot — drive your robot from any browser',
        note: 'What Bot is, and how a robot goes from added to driving.',
        text: 'OpenVibe.Bot is the open control panel for robots. Add a robot and pick its profile, pair it by pasting one command on the robot\'s computer, then drive it from any browser. The panel lays its controls out from the robot\'s profile: a touch joystick, the keyboard, a gamepad, buttons and sliders, with a latency meter. Every command passes one gate with roles, per-robot limits, cooldowns and a turn budget, and a latched emergency stop that only the owner clears; a stop pressed on the robot itself holds until it is released there. An owner can add people by username as operators or viewers, or open a queue where visitors take turns. A simulated rover runs inside Bot, so the whole panel can be tried before any hardware exists.',
    },
    {
        path: '/try', title: 'Try the panel with a simulated rover',
        note: 'Drive a simulated rover in the browser, no account and no hardware.',
        text: 'A rover simulated in the visitor\'s own browser, driven through the same OpenVibe.Bot panel a paired robot gets: a touch joystick, the keyboard (W A S D or the arrows, Space to stop) or a gamepad, with the same command shaping, deadman and latched e-stop. It has a front camera drawn from its position in a small arena, an ultrasonic distance sensor, three line sensors over a strip of yellow tape, a battery, RGB headlights and a horn. Nothing pressed there moves real hardware, and nothing needs an account. The page ends with the way to a real robot: add one, pair its computer with one pasted command, and the same panel drives it.',
    },
    {
        path: '/setup/sd-card', title: 'A robot from a blank microSD card',
        note: 'Set up a Raspberry Pi robot from a blank card with no screen or keyboard: the card adds the robot by itself.',
        text: 'A guided setup for a Raspberry Pi robot starting from a blank microSD card. Signed in, the person describes the robot (name, model, who may drive, its camera on their OpenVibe.Live channel) and their Wi-Fi, and chooses a login; the page makes the card\'s two cloud-init files, user-data and network-config, in the browser, so the Wi-Fi and login passwords never reach openvibe.bot (the login password is stored hashed with SHA-512 crypt). They write Raspberry Pi OS Lite (64-bit) to the card with Raspberry Pi Imager without its customisation, copy the two files to the card\'s bootfs drive and switch the robot on. On first boot the Pi joins the Wi-Fi, turns on SSH and I2C, and runs the OpenVibe installer with the card\'s setup key, which adds the robot to the person\'s account approved, with no code to read off a screen. The page follows the card until the robot is online. A setup key adds one robot and lasts 7 days; a retry before the robot pairs pairs the same robot again. If it does not arrive, the person can SSH to <hostname>.local with the login they chose and read journalctl -u openvibe-setup.',
    },
    {
        path: '/robots', title: 'Robots',
        note: 'The robot directory: robots people list, watchable live, and the models Bot drives.',
        text: 'The OpenVibe.Bot robot directory. Owners may list a robot; a listed robot has a public page where anyone can watch it live through its read-only panel, and a robot whose owner opened a queue lets signed-in visitors take timed turns at the controls. The page also lists every model Bot has a profile for, and, for a signed-in person, their own robots with the way to add one.',
    },
    {
        path: '/models', title: 'Models',
        note: 'Every robot model Bot drives, by how it connects.',
        text: 'The robots OpenVibe.Bot drives, grouped by how they connect: simulated (the rover that runs in Bot and in the browser), on-board (the OpenVibe Node on the robot\'s own computer: the Adeept ADR036 4WD car and its mecanum build, the relay robot for any Linux board), bridge (the Node on a computer or phone next to the robot: Cozmo through PyCozmo, the LOOI desk robot over Bluetooth) and server-side (ONVIF pan-tilt-zoom cameras, nothing to install). Each model has a page with how it connects, its setup steps, its guide and the controls its panel gets.',
    },
    {
        path: '/docs', title: 'Build for OpenVibe.Bot',
        note: 'The build index: drivers and robot profiles.',
        text: 'The build index for OpenVibe.Bot. Two things are open to build against: a driver, a separate program the OpenVibe Node runs and talks to in JSON lines over stdin/stdout, and a robot profile (bot.robot-profile@1), the JSON that says what a robot can do and which widgets its panel shows. The page links the driver guide and the profile guide, and points to the OpenVibe Node plugins tree, the protocol document and the plugin contract.',
    },
    {
        path: '/docs/drivers', title: 'Write a driver',
        note: 'The driver protocol: lifecycle, every message and the safety rules.',
        text: 'The driver protocol spec for OpenVibe.Bot. A driver is a separate executable the OpenVibe Node core starts, in any language, and the two speak JSON lines over stdin/stdout. The page covers what a driver is, the three connection kinds (on-board, bridge and server-side), the start-up lifecycle and restart rules, every message in both directions (hello, command, heartbeat, stop, estop, resume; describe, ready, fault, ack, nack, telemetry, event and video), the safety rules, a minimal Python driver, and how to test and contribute one.',
    },
    {
        path: '/docs/profiles', title: 'Robot profiles',
        note: 'The bot.robot-profile@1 format, a full example and a validator.',
        text: 'The robot profile format (bot.robot-profile@1) that OpenVibe.Bot renders a panel from. The page lists the fields (connection kind, motion kinds, commands, widgets and limits), shows a full example, and has a validator for a profile you paste. Profiles ship with Bot, including the simulated rover (sim.rover).',
    },
    {
        path: '/docs/automation', title: 'Routines, webhooks and your agent',
        note: 'Steps on a schedule, signed webhooks for a robot\'s events, and the switch that lets your OpenVibe.Actor agent drive.',
        text: 'How a robot on OpenVibe.Bot moves without anyone at the controls, through the same gate as a person (limits, cooldowns, e-stop, audit). Steps are plain lines checked against the robot\'s profile: forward, back, left and right for seconds at a speed, stop, wait, say, face, show, an actuator or camera axis with a value and a hold time, and press for a button; held steps are re-sent inside the deadman window and a refused step stops the rest with its reason. Routines run steps as the owner on demand, every N minutes (at least 5), daily at a UTC time on chosen weekdays, or each time the robot comes online; one runs at a time; 60 steps, 60 seconds a step, 10 minutes in all. Webhooks send a robot\'s bot.robot.online, bot.robot.offline, bot.estop.set, bot.estop.cleared and bot.command.refused events to up to five https addresses, each with its own whsec_ secret shown once, signed like OpenVibe.Events deliveries (X-OpenVibe-Timestamp, X-OpenVibe-Signature-V2, checked with verifyDeliveryV2 from openvibe-sdk/events), to public addresses only, retried after 30 seconds, 2, 10, 30 and 120 minutes. The Your agent switch, off until the owner turns it on, lets the owner\'s OpenVibe.Actor agent see their robots and run steps on that one as the owner, never for anyone else; a steps call on Bot\'s API runs up to 20 steps and 30 seconds and answers done, or stopped with the reason.',
    },
    {
        path: '/docs/computers', title: 'Your computer for your agents',
        note: 'The Node\'s computer plugin: levels set on the computer, approvals there, the agent switch and the API.',
        text: 'How to let your agents use your own computer through the OpenVibe Node\'s computer plugin. Installed with --computer, it runs as your own account, never root, and its only folder is your home. The level is set on the computer only: observe (screenshots, listing and reading files), ask (programs and writes each approved on the computer with openvibe-node approve), trusted (inside its folders without asking) or full. Programs are argv, never a shell line, time-limited and output-capped. The local stop drops it to observe. The switch Let my agent use this computer on openvibe.bot/machines lets your OpenVibe.Actor agent use it as you. Bot\'s machine commands take exec, fs and screen, and the computer\'s answer comes back in data.',
    },
    {
        path: '/updates', title: 'What shipped on OpenVibe.Bot',
        note: 'Every change deployed to OpenVibe.Bot, newest first, from the network\'s shared update log.',
        text: 'The update log of OpenVibe.Bot: every change deployed to the site, newest first, each line a commit from the OpenVibers repositories linked to the change itself. Batches of changes become Patch notes on openvibe.blog, and the whole network\'s log is on openvibe.network/updates.',
    },
    {
        path: '/terms', title: 'Terms of Service',
        note: 'The terms for using OpenVibe.Bot.',
        text: 'The terms for using OpenVibe.Bot: who may use it, the OpenVibe account, acceptable use, what you may pair and control, and the limits of the project\'s liability. The service is provided as it is, without warranties.',
    },
    {
        path: '/privacy', title: 'Privacy Policy',
        note: 'What OpenVibe.Bot collects, why, and your choices.',
        text: 'The privacy policy for OpenVibe.Bot: what the service collects and why, the first-party cookies it sets, what is shared with the services that run the network, how long things are kept, and the choices and rights you have over your data.',
    },
    {
        path: '/dmca', title: 'DMCA & Copyright',
        note: 'How to send a copyright notice or counter-notice.',
        text: 'How OpenVibe.Bot handles copyright: its position under the Digital Millennium Copyright Act, how to send a takedown notice, what happens next, counter-notices, and how repeat infringers and false claims are handled.',
    },
];
// The panel plays the robot's live video with mediasoup-client, whose npm package ships no browser
// bundle: the page imports the pinned ESM build OpenVibe.Live uses from esm.sh, and its viewer
// signaling endpoint is OpenRestream's wss host (OpenRestream README "playback descriptor"). Exactly these two
// sources, on the panel and embed pages only — the site-wide CSP (server/app.js) stays as it is.
// Plus Cloudflare's Web Analytics beacon, which the edge adds to every HTML page.
const PANEL_SCRIPT_SRC = 'https://esm.sh https://static.cloudflareinsights.com';
const PANEL_CONNECT_SRC = 'wss://ingest.openre.stream https://cloudflareinsights.com';
const PANEL_CSP = ["default-src 'self'", `script-src 'self' ${PANEL_SCRIPT_SRC}`, `connect-src 'self' ${PANEL_CONNECT_SRC}`,
    "frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'"].join('; ');
/** The embed's own CSP: the panel's sources plus the frame-ancestors allow-list. */
const embedCsp = (config) => ["default-src 'self'", `script-src 'self' ${PANEL_SCRIPT_SRC}`, `connect-src 'self' ${PANEL_CONNECT_SRC}`,
    `frame-ancestors ${frameAncestors(config)}`, "object-src 'none'", "base-uri 'self'"].join('; ');

function createWebRoutes(config, { domain = null, sim = null, onvif = null, limits = null, identity = null, hub = null, log = console, submissions = null, routines = null, webhooks = null, claims = null, setupKeys = null, releaseLastmod } = {}) {
    const r = express.Router();
    const networkReads = createNetworkReads({ searchUrl: config.search && config.search.url, log });
    // The public front page is crawlable; sign-in, the API and every signed-in or per-robot page are not.
    r.get('/robots.txt', (req, res) => res.type('text/plain').send(['User-agent: *', 'Allow: /$', 'Disallow: /auth/', 'Disallow: /api/',
        'Disallow: /robots/new', 'Disallow: /robots/submit', 'Disallow: /robots/submissions', 'Disallow: /pair/', 'Disallow: /setup/sd-card/keys', 'Disallow: /panel/', 'Disallow: /install', 'Disallow: /link', `Sitemap: ${config.baseUrl}/sitemap.xml`, ''].join('\n')));
    // `curl -fsSL` follows the redirect. The target is config only (checked at boot): no query parameter steers it.
    r.get('/install', (req, res) => res.redirect(302, config.installer.sourceUrl));
    // The sitemap lists every public GET page (openvibe-shared/seo); robots.txt already names it.
    r.get('/sitemap.xml', async (req, res, next) => {
        try {
            const pages = PUBLIC_PAGES.map((p) => ({ loc: `${config.baseUrl}${p}`, lastmod: releaseLastmod }));
            if (domain) {
                for (const row of await listProfiles(domain.db)) pages.push({ loc: `${config.baseUrl}/models/${row.profile.id}`, lastmod: releaseLastmod });
                for (const robot of await domain.robots.listListed({ limit: 200 })) {
                    pages.push({ loc: `${config.baseUrl}/r/${robot.id}`, lastmod: new Date(robot.updated_at).toISOString() });
                }
            }
            res.type('application/xml').send(seo.sitemapXml(pages));
        } catch (e) { next(e); }
    });
    // /llms.txt and /llms-full.txt (llmstxt.org, openvibe-shared/seo): the public pages as a plain-text map for
    // language-model crawlers. Only the pages above; the signed-in pages, the API and /internal are not listed.
    // Same headers as robots.txt: text/plain and no explicit Cache-Control.
    r.get('/llms.txt', (req, res) => res.type('text/plain').send(seo.llmsTxt({
        name: LLMS_NAME, summary: LLMS_SUMMARY,
        sections: [{ title: 'Pages', links: LLMS_PAGES.map((p) => ({ title: p.title, url: `${config.baseUrl}${p.path}`, note: p.note })) }],
    })));
    r.get('/llms-full.txt', (req, res) => res.type('text/plain').send(seo.llmsFull({
        site: LLMS_NAME, summary: LLMS_SUMMARY, base: config.baseUrl,
        sections: [{ title: 'Pages', pages: LLMS_PAGES.map((p) => ({ title: p.title, url: p.path, text: p.text })) }],
    })));
    // Browsers ask for /favicon.ico on their own (a 404 page links no icon): the app icon, as SVG.
    r.get('/favicon.ico', (req, res) => res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(appIcon.favicon({ site: 'bot' })));
    // The web app manifest. Its icons are the shared set (openvibe-shared/app-icons, under /shared/icons): it named
    // /assets/logo-*.png, which this site never served (every install icon was a 404 until 2026-10-17).
    r.get('/manifest.webmanifest', (req, res) => {
        res.type('application/manifest+json').send(JSON.stringify({
            ...appIcon.manifest({ site: 'bot', name: 'OpenVibe.Bot', shortName: 'Bot', description: SITE_TAGLINE, startUrl: '/' }),
            icons: [192, 512].flatMap((s) => [false, true].map((maskable) => ({ src: require('openvibe-shared/app-icons').url('bot', s, { maskable }), sizes: `${s}x${s}`, type: 'image/png', purpose: maskable ? 'maskable' : 'any' }))),
        }));
    });
    if (!domain) return r;

    const asset = (file, type) => (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.type(type).sendFile(path.join(PUBLIC, file)); };
    r.get('/panel/panel.js', asset('panel.js', 'application/javascript'));
    r.get('/panel/panel.css', asset('panel.css', 'text/css'));
    r.get('/panel/screen-share.js', asset('screen-share.js', 'application/javascript'));
    r.get('/panel/drive.js', asset('drive.js', 'application/javascript'));
    r.get('/panel/sim-world.js', asset('sim-world.js', 'application/javascript'));
    r.get('/panel/sim-view.js', asset('sim-view.js', 'application/javascript'));
    r.get('/panel/try-device.js', asset('try-device.js', 'application/javascript'));
    r.get('/panel/phone-device.js', asset('phone-device.js', 'application/javascript'));
    r.get('/panel/sd-card.js', asset('sd-card.js', 'application/javascript'));

    // /device/phone: a phone becomes the robot's device from its browser (plan T15). Public: the one-time pairing code
    // is the credential, and a paired phone keeps its device credential in its own storage. Its CSP adds only the
    // WHIP ingest the camera publishes to (BOT_WHIP_BASE's origin) and Cloudflare's beacon.
    const whipOrigin = (() => { try { return config.media.whipBase ? new URL(config.media.whipBase).origin : ''; } catch { return ''; } })();
    const PHONE_CSP = ["default-src 'self'", "script-src 'self' https://static.cloudflareinsights.com",
        `connect-src 'self'${whipOrigin ? ` ${whipOrigin}` : ''} https://cloudflareinsights.com`, "media-src 'self' blob:",
        "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"].join('; ');
    r.get('/device/phone', (req, res) => {
        res.setHeader('Content-Security-Policy', PHONE_CSP);
        res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.type('html').send(renderPhonePage());
    });
    r.get('/directory.css', asset('directory.css', 'text/css'));

    // /try: the real panel driving a rover simulated in the visitor's own browser (public/try-device.js), so anyone
    // can try it with no account and no hardware (plan T15 "a simulated robot in the browser"). Nothing reaches the
    // server after the page: no socket, no robot row, no limit to spend. The site-wide CSP holds (no outside source).
    const tryAllowed = Object.keys(TRY_PROFILE.commands);
    r.get('/try', (req, res) => {
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.type('html').send(renderPanel({
            robot: { id: 'try', name: 'Practice rover', profile_id: TRY_PROFILE.id, access_policy: 'private', estop: { latched: false } },
            profile: TRY_PROFILE, role: 'owner', allowed_commands: tryAllowed, holdResendMs: HOLD_RESEND_MS, tryIt: true,
        }));
    });

    const requireUser = (req) => {
        if (!req.viewer) throw new BotError(401, 'bot.sign_in', 'sign in first');
        return req.viewer;
    };
    const profileOf = async (robot) => {
        const row = await getProfile(domain.db, robot.profile_id, robot.profile_version);
        return row ? row.profile : null;
    };
    // A sim or configured-ONVIF robot needs no machine to install: attach its in-process device if the profile
    // is one (and, for ONVIF, BOT_ONVIF_CAMERAS names it). Anything else falls through to the pairing page.
    const attachInProcess = async (robot, profile) => {
        if (sim && await sim.attach(robot, profile).catch((e) => { log.warn(`[Bot] simulator for ${robot.id}: ${e.message}`); return false; })) return true;
        if (onvif && await onvif.attach(robot, profile).catch((e) => { log.warn(`[Bot] onvif for ${robot.id}: ${e.message}`); return false; })) return true;
        return false;
    };
    // Counted by who is signed in (req.principal, as /api/v1 counts), or by address before the sign-in redirect.
    const manage = limits
        ? [(req, res, next) => { if (req.viewer && !req.principal) req.principal = req.viewer; next(); }, limits('bot.robot.manage', { minute: 30, hour: 300 })]
        : [];
    /** A page handler: 401 → sign in and come back, 403/404 → a plain answer, anything else → the app's 500. */
    const page = (fn) => async (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        try { await fn(req, res); } catch (e) {
            if (e.status === 401) return res.redirect(302, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
            // A refusal the person can act on (a bad form value, a robot with no stream, OpenRestream not answering) says so
            // with its own status instead of the generic error page.
            if ([403, 404, 409, 422, 502, 503].includes(e.status) && e.code) return res.status(e.status).type('text/plain').send(`${e.detail || e.code}\n`);
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

    // ── The public build pages (plan T15): /docs, /docs/drivers and /docs/profiles. ──
    // They are rendered with the app's page helper, carry no script, and run under the site-wide CSP. The
    // profile validator is anonymous, so it is rate-limited per address the way the app's other public limits
    // are, and a cross-site form post is refused as every other form post refuses one.
    const validateLimit = limits ? [limits('bot.docs.validate', { minute: 30, hour: 300 })] : [];
    // The Build pages run inside the OpenVibe Frame (navbar, footer, theme), so they take the front page's CSP.
    const frameCsp = (req, res, next) => { res.setHeader('Content-Security-Policy', HOME_CSP); next(); };
    r.get('/docs/docs.css', asset('docs.css', 'text/css'));
    r.get('/docs', frameCsp, (req, res) => res.type('html').send(renderDocsIndex({ config })));
    // What shipped on this site: the shared update log, as on every OpenVibe site.
    r.get('/updates', frameCsp, (req, res) => res.type('html').send(renderUpdates({ config })));
    r.get('/docs/drivers', frameCsp, (req, res) => res.type('html').send(renderDriversPage({ config })));
    r.get('/docs/profiles', frameCsp, (req, res) => res.type('html').send(renderProfilesPage({ config })));
    r.get('/docs/automation', frameCsp, (req, res) => res.type('html').send(renderAutomationPage({ config })));
    r.get('/docs/computers', frameCsp, (req, res) => res.type('html').send(renderComputersPage({ config })));
    r.post('/docs/profiles/validate', frameCsp, ...validateLimit, express.urlencoded({ extended: false, limit: '32kb' }), (req, res, next) => {
        try {
            if (!sameOrigin(req)) return res.status(403).type('text/plain').send('cross-site form posts are refused\n');
            res.setHeader('Cache-Control', 'no-store');
            const source = typeof (req.body && req.body.profile) === 'string' ? req.body.profile : '';
            let result;
            if (!source.trim()) result = { valid: false, problems: ['Paste a profile JSON to validate.'] };
            else {
                try { result = checkProfile(JSON.parse(source)); }
                catch (e) { result = { valid: false, problems: [`not valid JSON: ${e.message}`] }; }
            }
            return res.type('html').send(renderProfilesPage({ config, source, result }));
        } catch (e) { return next(e); }
    });

    // The phone's pairing link (the QR code): the robot and code ride in the fragment, which never reaches a server.
    const phoneUrl = (robotId, pairing) => `${config.baseUrl}/device/phone#robot=${encodeURIComponent(robotId)}&code=${encodeURIComponent(pairing.code)}`;

    // The embed flag is web-only: domain.present.robot (and so /api/v1) does not carry it.
    const presentForPage = (row) => ({ ...domain.present.robot(row), embed_public: !!row.embed_public, listed: !!row.listed, agent_control: !!row.agent_control });

    // The front page of openvibe.bot (server/web/home.js): public, indexable, with the OpenVibe Frame. Its two
    // actions differ by sign-in, so it is never stored by a shared cache.
    // Its data sections: the catalogue, the robots people list (online first), the first kit, and robotics openings
    // from OpenVibe.Search (cached; empty without BOT_SEARCH_URL).
    r.get('/', async (req, res, next) => {
        try {
            const [models, rows, jobs] = await Promise.all([catalogue(), domain.robots.listListed({ limit: 24 }), networkReads.jobs()]);
            const byId = new Map(models.map((m) => [m.id, m]));
            const names = await namesOf(rows.map((row) => row.owner_subject));
            const robots = (await Promise.all(rows.map(async (row) => ({
                id: row.id, name: row.name, access_policy: row.access_policy, owner: names.get(row.owner_subject) || null, online: await onlineOf(row.id),
                model_name: (byId.get(row.profile_id) || { name: row.profile_id.startsWith('local.') ? 'Its own profile' : row.profile_id }).name,
            })))).sort((a, b) => Number(b.online) - Number(a.online));
            const kit = kits.list()[0] || null;
            res.setHeader('Content-Security-Policy', HOME_CSP);
            res.setHeader('Cache-Control', 'private, no-cache');
            res.setHeader('Vary', 'Cookie');
            res.type('html').send(renderHome({ config, signedIn: !!req.viewer, models: sortModels(models), robots, kit, jobs }));
        } catch (e) { next(e); }
    });
    r.get('/home.css', asset('home.css', 'text/css'));

    // ── The directory (plan T15 "a robot directory (/robots)"): public pages inside the OpenVibe Frame. ──
    // Every catalogue profile as a model; a community one carries its approved submission (who, driver, guide, key).
    const catalogue = async () => {
        const approved = submissions ? await submissions.community() : [];
        const names = approved.length ? await namesOf(approved.map((s) => s.submitter_subject).filter(Boolean)) : new Map();
        const by = new Map(approved.map((s) => [s.profile_id, { by: names.get(s.submitter_subject) || null, driver_url: s.driver_url, guide_url: s.guide_url, license: s.license, key_id: s.key_id }]));
        return (await listProfiles(domain.db)).map((row) => modelOf(row.profile, by.get(row.profile.id) || null));
    };
    const namesOf = async (subjects) => {
        if (!identity || !subjects.length) return new Map();
        try { return await identity.names([...new Set(subjects)]); } catch (e) { log.warn(`[Bot] directory names: ${e.message}`); return new Map(); }
    };
    const onlineOf = async (id) => { try { return !!(hub && (await hub.robotState(id)).online); } catch { return false; } };

    r.get('/robots', frameCsp, page(async (req, res) => {
        res.setHeader('Cache-Control', 'private, no-cache');
        res.setHeader('Vary', 'Cookie');
        const models = await catalogue();
        const byId = new Map(models.map((m) => [m.id, m]));
        const modelName = (row) => (byId.get(row.profile_id) || { name: row.profile_id.startsWith('local.') ? 'Its own profile' : row.profile_id }).name;
        const rows = await domain.robots.listListed({ limit: 60 });
        const names = await namesOf(rows.map((r) => r.owner_subject));
        const listed = await Promise.all(rows.map(async (row) => ({
            id: row.id, name: row.name, access_policy: row.access_policy, model_name: modelName(row),
            owner: names.get(row.owner_subject) || null, online: await onlineOf(row.id),
        })));
        const mine = req.viewer ? (await domain.robots.list(req.viewer.subject)).map((row) => ({ id: row.id, name: row.name, listed: !!row.listed, model_name: modelName(row) })) : null;
        res.type('html').send(renderDirectory({ config, listed, mine, models, signedIn: !!req.viewer }));
    }));
    r.get('/models', frameCsp, page(async (req, res) => {
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.type('html').send(renderModels({ config, models: await catalogue() }));
    }));
    r.get('/models/:id', frameCsp, page(async (req, res) => {
        const model = (await catalogue()).find((m) => m.id === req.params.id);
        if (!model) throw new BotError(404, 'bot.profile_not_found', 'no such model');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.type('html').send(renderModel({ config, model, kit: kits.list().find((k) => k.profile_id === model.id) || null }));
    }));
    // A listed robot's public page; its owner and members see their own robot's page whether it is listed or not.
    r.get('/r/:id', frameCsp, page(async (req, res) => {
        res.setHeader('Cache-Control', 'private, no-cache');
        res.setHeader('Vary', 'Cookie');
        const robot = await domain.robots.get(req.params.id);
        const role = robot && req.viewer ? await memberRole(robot, req.viewer) : null;
        if (!robot || (!robot.listed && !role)) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        const row = await getProfile(domain.db, robot.profile_id, robot.profile_version);
        const model = row ? modelOf(row.profile) : { id: robot.profile_id, name: robot.profile_id };
        const owner = (await namesOf([robot.owner_subject])).get(robot.owner_subject) || null;
        const state = { online: await onlineOf(robot.id) };
        res.type('html').send(renderRobotPage({ config, robot: { id: robot.id, name: robot.name, access_policy: robot.access_policy }, model, owner, state, role: role === 'queue' ? null : role }));
    }));
    // Adding a robot (the five-minute path's first step): name it, choose what it is, who may drive.
    async function addPage(req, res, extra = {}) {
        res.setHeader('Content-Security-Policy', HOME_CSP);
        const models = (await catalogue()).filter((m) => !m.id.startsWith('local.'));
        const asked = typeof req.query.profile === 'string' && models.some((m) => m.id === req.query.profile) ? req.query.profile : null;
        const values = extra.values || (asked ? { profile_id: asked } : {});
        res.type('html').send(renderAddRobot({ config, models, values, error: extra.error || null }));
    }
    r.get('/robots/new', page(async (req, res) => { requireUser(req); return addPage(req, res); }));

    // ── Community robots (server/submissions.js): submit a profile, see where it stands; admins review. ──
    const submitLimit = limits ? [(req, res, next) => { if (req.viewer && !req.principal) req.principal = req.viewer; next(); }, limits('bot.profile.submit', { minute: 20, hour: 60 })] : [];
    const isReviewer = (me) => !!(me && me.role === 'admin');
    r.get('/robots/submit', page(async (req, res) => {
        requireUser(req);
        res.setHeader('Content-Security-Policy', HOME_CSP);
        res.type('html').send(renderSubmit({ config, licenses: LICENSES }));
    }));
    r.post('/robots/submit', ...submitLimit, express.urlencoded({ extended: false, limit: '48kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        if (!submissions) throw new BotError(503, 'bot.unavailable', 'submissions are not available');
        const b = req.body || {};
        const values = { profile: String(b.profile || ''), driver_url: String(b.driver_url || ''), guide_url: String(b.guide_url || ''), license: String(b.license || ''), notes: String(b.notes || '') };
        let profile;
        try { profile = JSON.parse(values.profile); } catch (e) {
            res.status(422).setHeader('Content-Security-Policy', HOME_CSP);
            return res.type('html').send(renderSubmit({ config, licenses: LICENSES, values, error: `The profile is not valid JSON: ${e.message}` }));
        }
        try {
            await submissions.submit(me, { profile, driver_url: values.driver_url, guide_url: values.guide_url, license: values.license, notes: values.notes });
        } catch (e) {
            if (!e.status || e.status >= 500 || e.status === 401) throw e;
            res.status(e.status).setHeader('Content-Security-Policy', HOME_CSP);
            return res.type('html').send(renderSubmit({ config, licenses: LICENSES, values, error: e.detail || e.code }));
        }
        return res.redirect(303, '/robots/submissions');
    }));
    r.get('/robots/submissions', page(async (req, res) => {
        const me = requireUser(req);
        if (!submissions) throw new BotError(503, 'bot.unavailable', 'submissions are not available');
        res.setHeader('Content-Security-Policy', HOME_CSP);
        const pending = isReviewer(me) ? await submissions.pending() : null;
        const names = pending && pending.length ? await namesOf(pending.map((s) => s.submitter_subject).filter(Boolean)) : new Map();
        res.type('html').send(renderSubmissions({ config, mine: await submissions.mine(me.subject), pending, names, signing: submissions.signingKey() }));
    }));
    r.post('/robots/submissions/:id/review', ...manage, express.urlencoded({ extended: false, limit: '4kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        if (!submissions) throw new BotError(503, 'bot.unavailable', 'submissions are not available');
        await submissions.review(req.params.id, me, { decision: String(req.body.decision || ''), note: req.body.note });
        return res.redirect(303, '/robots/submissions');
    }));
    r.post('/robots/submissions/:id/withdraw', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        if (!submissions) throw new BotError(503, 'bot.unavailable', 'submissions are not available');
        await submissions.withdraw(req.params.id, me);
        return res.redirect(303, '/robots/submissions');
    }));

    r.post('/robots', ...manage, express.urlencoded({ extended: false, limit: '8kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const body = req.body || {};
        const values = { name: typeof body.name === 'string' ? body.name : '', profile_id: String(body.profile_id || ''), access_policy: String(body.access_policy || 'private') };
        let robot, pairing;
        try {
            ({ robot, pairing } = await domain.robots.create({ owner: me.subject, name: values.name, profile_id: values.profile_id, access_policy: values.access_policy }));
        } catch (e) {
            if (e.status === 422) { res.status(422); return addPage(req, res, { error: e.detail || e.code, values }); }
            throw e;
        }
        // A simulated robot needs no machine: straight to its panel. Otherwise the code create minted is shown here.
        const profile = await profileOf(robot);
        if (await attachInProcess(robot, profile)) return res.redirect(303, `/panel/${robot.id}`);
        return res.status(201).type('html').send(renderPairingPage({ robot: domain.present.robot(robot), pairing, profile, phoneUrl: phoneUrl(robot.id, pairing) }));
    }));

    // ── A device that asked to be added (server/claims.js): its code, what it found, approve or deny ──
    // Looking a code up is counted per person like Add robot, so codes cannot be guessed from here either.
    const lookup = limits
        ? [(req, res, next) => { if (req.viewer && !req.principal) req.principal = req.viewer; next(); }, limits('bot.claim.lookup', { minute: 20, hour: 200 })]
        : [];
    // What a claimed device can be: a model the installer has a driver for, or the generic relay (your own program).
    const claimModels = async () => (await catalogue())
        .filter((m) => !m.id.startsWith('local.') && (domain.pairing.driverForProfile(m.id) !== 'none' || m.id === 'relay.generic'));
    const linkInstaller = () => `curl -fsSL ${config.installer.scriptUrl} | sh`;
    const needClaims = () => { if (!claims) throw new BotError(404, 'bot.not_found', 'adding a device by code is not available here'); };
    r.get('/link', ...lookup, page(async (req, res) => {
        requireUser(req);
        needClaims();
        const code = typeof req.query.code === 'string' ? req.query.code.slice(0, 20) : '';
        if (!code) return res.type('html').send(renderLinkPage({ installer: linkInstaller() }));
        const claim = await claims.find(code);
        if (!claim) {
            return res.status(404).type('html').send(renderLinkPage({ code, installer: linkInstaller(),
                error: 'No device is waiting with that code. A code lasts 15 minutes: run the command on the device again for a new one.' }));
        }
        return res.type('html').send(renderClaimPage({ claim, models: await claimModels() }));
    }));
    r.post('/link/:id/approve', ...manage, express.urlencoded({ extended: false, limit: '4kb' }), page(async (req, res) => {
        const me = requireUser(req);
        needClaims();
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const body = req.body || {};
        const values = { name: typeof body.name === 'string' ? body.name : '', profile_id: String(body.profile_id || ''),
            access_policy: String(body.access_policy || 'private'), live: body.live === 'on' };
        const models = await claimModels();
        let made;
        try {
            if (!models.some((m) => m.id === values.profile_id)) throw new BotError(422, 'bot.unknown_profile', 'choose one of the models listed');
            made = await claims.approve(req.params.id, me.subject, values);
        } catch (e) {
            if (e.status === 422) {
                const claim = await claims.waiting(req.params.id);
                return res.status(422).type('html').send(renderClaimPage({ claim, models, values, error: e.detail || e.code }));
            }
            throw e;
        }
        const profile = await profileOf(made.robot);
        // Their Live channel (the username is the same on every site) binds the robot to its chat after they confirm there.
        const liveOrigin = (config.embed && config.embed.origins && config.embed.origins[0]) || null;
        const username = req.viewerClaims && typeof req.viewerClaims.username === 'string' ? req.viewerClaims.username : '';
        const chatUrl = liveOrigin && username ? `${liveOrigin}/@${encodeURIComponent(username)}?bind_robot=${encodeURIComponent(made.robot.id)}` : null;
        return res.status(201).type('html').send(renderClaimApproved({ robot: domain.present.robot(made.robot), profile, live: values.live, chatUrl }));
    }));
    r.post('/link/:id/deny', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        needClaims();
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        await claims.deny(req.params.id, me.subject);
        return res.type('html').send(renderLinkPage({ installer: linkInstaller(), error: 'Denied. That device was told no and added nothing.' }));
    }));

    // ── A robot from a blank microSD card (server/setup-keys.js, server/web/sd-card.js, public/sd-card.js) ──
    // The page is public (the steps), the form needs a sign-in. The browser asks for a setup key with the robot's
    // choices only (never the Wi-Fi or login password, which go only into the files it makes) and follows the card.
    const sdJson = (fn) => async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try { await fn(req, res); } catch (e) {
            const status = e.status && e.status < 600 ? e.status : 500;
            if (status === 500) log.warn(`[Bot] setup key: ${e.message}`);
            res.status(status).json({ error: e.code || 'bot.error', detail: status === 500 ? 'something went wrong; try again' : (e.detail || e.code) });
        }
    };
    const needSetupKeys = () => { if (!setupKeys || !claims) throw new BotError(404, 'bot.not_found', 'card setup is not available here'); };
    r.get('/setup/sd-card', page(async (req, res) => {
        needSetupKeys();
        res.setHeader('Content-Security-Policy', HOME_CSP);
        const models = await claimModels();
        const asked = typeof req.query.profile === 'string' && models.some((m) => m.id === req.query.profile) ? req.query.profile : null;
        res.type('html').send(renderSdCard({ config, signedIn: !!req.viewer, models, values: { profile_id: asked } }));
    }));
    r.post('/setup/sd-card/keys', ...manage, express.json({ limit: '4kb' }), sdJson(async (req, res) => {
        needSetupKeys();
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site requests are refused');
        const b = req.body || {};
        const models = await claimModels();
        if (!models.some((m) => m.id === b.profile_id)) throw new BotError(422, 'bot.unknown_profile', 'choose one of the models listed');
        const out = await setupKeys.create(me.subject, { name: b.name, profile_id: b.profile_id, access_policy: String(b.access_policy || 'private'),
            live: b.live === true, hostname: typeof b.hostname === 'string' ? b.hostname : null });
        res.status(201).json(out);
    }));
    r.get('/setup/sd-card/keys/:id', ...manage, sdJson(async (req, res) => {
        needSetupKeys();
        const me = requireUser(req);
        const s = await setupKeys.status(me.subject, req.params.id);
        if (!s) throw new BotError(404, 'bot.not_found', 'no such card files');
        res.json(s);
    }));
    r.post('/setup/sd-card/keys/:id/revoke', ...manage, sdJson(async (req, res) => {
        needSetupKeys();
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site requests are refused');
        await setupKeys.revoke(me.subject, req.params.id);
        res.json({ revoked: true });
    }));

    // A load replaces the robot's unused code, so only a navigation from this site (or a typed address) mints one.
    const crossSiteOrPrefetch = (req) => {
        const site = req.headers['sec-fetch-site'];
        const purpose = String(req.headers['sec-purpose'] || req.headers.purpose || req.headers['x-moz'] || '');
        return (site && site !== 'same-origin' && site !== 'none') || /prefetch|prerender/i.test(purpose);
    };
    // ── The person's own machines that run their jobs (plan T14/T16) ──
    const machineRows = async (subject) => Promise.all((await domain.machines.list(subject)).map(async (d) => {
        const robotId = Array.isArray(d.robot_ids) ? d.robot_ids[0] : null;
        const robot = robotId ? await domain.robots.get(robotId) : null;
        const sensors = hub ? ((hub.deviceState(d.id).telemetry || {}).sensors || {}) : {};
        return {
            ...d, online: !!(hub && hub.isOnline(d.id)), robot: robot ? robot.name : null,
            computer_level: typeof sensors.computer_level === 'string' ? sensors.computer_level : null,
            computer_waiting: Number.isInteger(sensors.computer_waiting) ? sensors.computer_waiting : null,
            computer_screen_stream: sensors.computer_screen_stream === 'live' ? 'live' : 'off',
        };
    }));
    // ── The live screen (plan T14): the owner watches their machine's screen on their own private stream ──
    const machineScreen = createMachineScreen({ domain, hub });
    const myMachine = async (req, me) => {
        const mine = (await domain.machines.list(me.subject)).find((d) => d.id === req.params.id);
        if (!mine) throw new BotError(404, 'bot.device_not_found', 'no such machine of yours');
        return mine;
    };
    const asUser = (me) => ({ kind: 'user', sub: me.subject });
    // The machine has a private desk to show (Node v0.15.0 on Linux): its owner may show it, or share it, instead.
    const hasDesk = (mine) => !!(hub && (hub.computerOf(mine.id) || {}).desk);
    r.post('/machines/:id/screen', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const mine = await myMachine(req, me);
        try {
            const out = await machineScreen.start(mine, me.subject, asUser(me), { desk: req.body && req.body.desk === 'private' ? 'private' : 'main' });
            res.redirect(303, `/machines/${encodeURIComponent(mine.id)}/screen?until=${encodeURIComponent(out.until)}`);
        } catch (e) {
            if (!(e instanceof BotError)) throw e;
            res.setHeader('Content-Security-Policy', PANEL_CSP);
            res.status(e.status).type('html').send(renderMachineScreenPage({ machine: mine, error: e.detail || e.message, hasDesk: hasDesk(mine) }));
        }
    }));
    r.get('/machines/:id/screen', page(async (req, res) => {
        const me = requireUser(req);
        const mine = await myMachine(req, me);
        const until = typeof req.query.until === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(req.query.until) ? req.query.until : null;
        // Opened from a link with nothing shown: offer to start it rather than wait for a stream nobody started.
        const idle = !until && (await machineScreen.state(mine, me.subject)).state !== 'live';
        res.setHeader('Vary', 'Cookie');
        res.setHeader('Content-Security-Policy', PANEL_CSP);
        res.type('html').send(renderMachineScreenPage({ machine: mine, until, idle, shares: await shares.list(mine, me.subject).catch(() => []), hasDesk: hasDesk(mine) }));
    }));
    r.get('/machines/:id/screen.json', page(async (req, res) => {
        const me = requireUser(req);
        const mine = await myMachine(req, me);
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(await machineScreen.state(mine, me.subject));
    }));
    r.post('/machines/:id/screen/stop', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const mine = await myMachine(req, me);
        await machineScreen.stop(mine, me.subject, asUser(me));
        res.redirect(303, '/machines');
    }));
    // ── Screen share links (server/screen-shares.js): the owner shares the live screen with a group, to watch or use ──
    const shares = createScreenShares({ db: domain && domain.db, domain, hub, machineScreen });
    // A share page may sit in OpenVibe's own workspaces (a room on OpenVibe.Chat, the admin panel) and the configured embeds.
    const shareCsp = ["default-src 'self'", `script-src 'self' ${PANEL_SCRIPT_SRC}`, `connect-src 'self' ${PANEL_CONNECT_SRC}`,
        `frame-ancestors ${frameAncestors(config)} https://openvibe.chat https://openvibe.network`, "object-src 'none'", "base-uri 'self'"].join('; ');
    r.post('/machines/:id/shares', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const mine = await myMachine(req, me);
        const made = await shares.create(mine, me.subject, { label: req.body && req.body.label, control: req.body && req.body.control === '1', days: (req.body && req.body.days) || 30, desk: req.body && req.body.desk === 'private' ? 'private' : 'main' });
        res.setHeader('Content-Security-Policy', PANEL_CSP);
        res.type('html').send(renderMachineScreenPage({ machine: mine, idle: true, shares: await shares.list(mine, me.subject), madeLink: `${config.baseUrl}/screen/${made.token}`, madeShare: made.share, hasDesk: hasDesk(mine) }));
    }));
    r.post('/machines/:id/shares/:share/revoke', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const mine = await myMachine(req, me);
        await shares.revoke(mine, me.subject, req.params.share);
        res.redirect(303, `/machines/${encodeURIComponent(mine.id)}/screen`);
    }));
    const shareJson = (fn) => async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try { res.json(await fn(req)); } catch (e) {
            if (!(e instanceof BotError)) { log.warn(`[Bot] screen share: ${e.message}`); return res.status(500).json({ code: 'bot.internal', detail: 'something went wrong' }); }
            res.status(e.status).json({ code: e.code, detail: e.detail || e.message });
        }
    };
    const shareLimit = limits ? [limits('bot.screen.share', { minute: 600, hour: 6000 })] : [];
    r.get('/screen/:token', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Content-Security-Policy', shareCsp);
        const s = await shares.open(req.params.token).catch(() => null);
        if (!s) return res.status(404).type('html').send(renderShareGone());
        res.type('html').send(renderSharePage({ token: req.params.token, name: s.device.name || 'A computer', control: !!s.share.control, label: s.share.label, desk: s.share.desk === 'private' ? 'private' : 'main' }));
    });
    r.get('/screen/:token/state.json', shareJson(async (req) => await shares.state(req.params.token)));
    r.post('/screen/:token/start', ...shareLimit, shareJson(async (req) => await shares.start(req.params.token)));
    r.post('/screen/:token/stop', ...shareLimit, shareJson(async (req) => await shares.stop(req.params.token)));
    r.post('/screen/:token/input', ...shareLimit, express.json({ limit: '2kb' }), shareJson(async (req) => await shares.input(req.params.token, req.body || {})));

    r.get('/machines', frameCsp, page(async (req, res) => {
        const me = requireUser(req);
        res.setHeader('Vary', 'Cookie');
        res.type('html').send(renderMachinesPage({ machines: await machineRows(me.subject) }));
    }));
    r.post('/machines', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const pairing = await domain.machines.mint(me.subject);
        res.status(201).type('html').send(renderMachinesPage({ machines: await machineRows(me.subject), pairing }));
    }));
    // The owner lets their watches (OpenVibe.Watch's node source) probe from this machine, or stops them.
    r.post('/machines/:id/watch-probe', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const mine = (await domain.machines.list(me.subject)).find((d) => d.id === req.params.id);
        if (!mine) throw new BotError(404, 'bot.device_not_found', 'no such machine of yours');
        await domain.machines.setWatchProbe(mine.id, req.body && req.body.on === '1');
        res.redirect(303, '/machines');
    }));
    // The owner lets their agent (OpenVibe.Actor) use this machine's computer plugin, or stops it.
    r.post('/machines/:id/agent-computer', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const mine = (await domain.machines.list(me.subject)).find((d) => d.id === req.params.id);
        if (!mine) throw new BotError(404, 'bot.device_not_found', 'no such machine of yours');
        await domain.machines.setAgentComputer(mine.id, req.body && req.body.on === '1');
        res.redirect(303, '/machines');
    }));
    r.post('/machines/:id/remove', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const mine = (await domain.machines.list(me.subject)).find((d) => d.id === req.params.id);
        if (!mine) throw new BotError(404, 'bot.device_not_found', 'no such machine of yours');
        await domain.devices.revoke(mine.id);
        await domain.machines.screen.archive(mine, me.subject).catch((e) => log.warn(`[Bot] machine ${mine.id} screen stream: ${e.message}`));
        if (mine.node_principal) await domain.devices.revokeNode(mine.node_principal).catch((e) => log.warn(`[Bot] machine ${mine.id} on Network: ${e.message}`));
        if (hub) hub.closeDevice(mine.id, 'revoked');
        res.redirect(303, '/machines');
    }));

    r.get('/pair/:id', ...manage, page(async (req, res) => {
        const me = requireUser(req);
        if (crossSiteOrPrefetch(req)) return res.redirect(303, '/robots');
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        if (robot.owner_subject !== me.subject) throw new BotError(403, 'bot.forbidden', 'only the owner may pair a device');
        const pairing = await domain.pairing.create(robot.id, me.subject, undefined, robot);
        res.type('html').send(renderPairingPage({ robot: domain.present.robot(robot), pairing, profile: await profileOf(robot), phoneUrl: phoneUrl(robot.id, pairing) }));
    }));

    // ── Routines and webhooks (the owner's panel cards; the same rules as /api/v1) ──
    async function ownRobot(req) {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        if (robot.owner_subject !== me.subject) throw new BotError(403, 'bot.forbidden', 'only the owner manages routines and webhooks');
        if (!routines || !webhooks) throw new BotError(503, 'bot.unavailable', 'automation is not available');
        return { me, robot };
    }
    const many = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
    r.post('/robots/:id/routines', ...manage, express.urlencoded({ extended: false, limit: '16kb' }), page(async (req, res) => {
        const { me, robot } = await ownRobot(req);
        const b = req.body || {};
        const kind = String(b.trigger || 'manual');
        const trigger = kind === 'every' ? { type: 'schedule', every: b.every } : kind === 'daily' ? { type: 'schedule', at: b.at, days: many(b.days) } : { type: kind };
        try {
            await routines.create(robot, me, { name: b.name, source: b.steps, trigger }, await profileOf(robot));
        } catch (e) {
            if (e.status !== 422) throw e;
            res.status(422);
            return sendPanel(res, robot, await profileOf(robot), 'owner', 'page', true, { automation: { routineError: e.detail || e.message, values: { name: b.name, steps: b.steps, trigger: kind, every: b.every, at: b.at, days: many(b.days) } } });
        }
        return res.redirect(303, `/panel/${robot.id}#routines`);
    }));
    r.post('/robots/:id/routines/:rid/run', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const { robot } = await ownRobot(req);
        const routine = await routines.get(req.params.rid);
        if (!routine || routine.robot_id !== robot.id) throw new BotError(404, 'bot.routine_not_found', 'no such routine');
        await routines.run(routine.id, { reason: 'owner' });
        return res.redirect(303, `/panel/${robot.id}#routines`);
    }));
    r.post('/robots/:id/routines/:rid/remove', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const { robot } = await ownRobot(req);
        await routines.remove(robot.id, req.params.rid);
        return res.redirect(303, `/panel/${robot.id}#routines`);
    }));
    r.post('/robots/:id/webhooks', ...manage, express.urlencoded({ extended: false, limit: '4kb' }), page(async (req, res) => {
        const { me, robot } = await ownRobot(req);
        let made;
        try { made = await webhooks.create(robot, me, { url: req.body.url, events: many(req.body.events) }); } catch (e) {
            if (![409, 422].includes(e.status)) throw e;
            res.status(e.status);
            return sendPanel(res, robot, await profileOf(robot), 'owner', 'page', true, { automation: { webhookError: e.detail || e.message } });
        }
        // The secret is shown on this page alone (never in a URL), so the answer is the panel itself.
        res.status(201);
        return sendPanel(res, robot, await profileOf(robot), 'owner', 'page', true, { automation: { webhookSecret: made.secret } });
    }));
    r.post('/robots/:id/webhooks/:hid/remove', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const { robot } = await ownRobot(req);
        await webhooks.remove(robot.id, req.params.hid);
        return res.redirect(303, `/panel/${robot.id}#webhooks`);
    }));

    r.post('/robots/:id/agent', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        if (robot.owner_subject !== me.subject) throw new BotError(403, 'bot.forbidden', 'only the owner decides about their agent');
        const sent = req.body && req.body.agent_control;
        const value = Array.isArray(sent) ? sent[sent.length - 1] : sent;
        if (value !== 'on' && value !== 'off') throw new BotError(422, 'bot.invalid_input', 'agent_control must be on or off');
        await domain.robots.setAgentControl(robot.id, value === 'on');
        res.redirect(303, `/panel/${robot.id}#agent`);
    }));

    r.post('/robots/:id/listing', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        if (robot.owner_subject !== me.subject) throw new BotError(403, 'bot.forbidden', 'only the owner may list a robot');
        const sent = req.body && req.body.listed;
        const value = Array.isArray(sent) ? sent[sent.length - 1] : sent;
        if (value !== 'on' && value !== 'off') throw new BotError(422, 'bot.invalid_input', 'listed must be on or off');
        await domain.robots.setListed(robot.id, value === 'on');
        res.redirect(303, `/panel/${robot.id}`);
    }));

    r.post('/robots/:id/embed', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        if (robot.owner_subject !== me.subject) throw new BotError(403, 'bot.forbidden', 'only the owner may change embedding');
        // The hidden "off" comes first, the checked box's "on" after it: the last value wins.
        const sent = req.body && req.body.embed_public;
        const value = Array.isArray(sent) ? sent[sent.length - 1] : sent;
        if (value !== 'on' && value !== 'off') throw new BotError(422, 'bot.invalid_input', 'embed_public must be on or off');
        await domain.robots.setEmbedPublic(robot.id, value === 'on');
        if (value === 'off' && domain.link && domain.link.closeWatchers) domain.link.closeWatchers(robot.id);
        res.redirect(303, `/panel/${robot.id}`);
    }));

    // The owner's streaming switches as a plain form (the same as POST /api/v1/robots/:id/streaming, once per
    // switch): media=on|off and live=on|off, each after its hidden "off" so the last value wins. A switch the
    // owner did not touch (its value equals the <name>_was the page was drawn with) is not sent, so a stale tab
    // never reverts a change made elsewhere; the domain is idempotent besides → 303 to the panel.
    r.post('/robots/:id/streaming', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        if (robot.owner_subject !== me.subject) throw new BotError(403, 'bot.forbidden', 'only the owner may change streaming');
        const last = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
        const changes = [];
        for (const to of ['media', 'live']) {
            const value = last(req.body && req.body[to]);
            if (value !== 'on' && value !== 'off') throw new BotError(422, 'bot.invalid_input', `${to} must be on or off`);
            const was = last(req.body && req.body[`${to}_was`]);
            if (was !== value) changes.push({ to, on: value === 'on' });
        }
        // One switch can be saved before OpenRestream refuses or stops answering for the next: say which one was.
        const saved = [];
        for (const change of changes) {
            try { await domain.streaming.set(robot.id, me, change); saved.push(change.to); } catch (e) {
                if (!saved.length || !(e instanceof BotError)) throw e;
                throw new BotError(e.status, e.code, `${saved.join(' and ')} was saved, ${change.to} was not: ${e.detail || e.code}`);
            }
        }
        res.redirect(303, `/panel/${robot.id}`);
    }));

    // The owner adds a person to the robot by their OpenVibe username. Network resolves the @name to a subject;
    // an unknown name is 422 with that name in the detail. The owner (already the owner row) may not be added.
    r.post('/robots/:id/operators', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        if (robot.owner_subject !== me.subject) throw new BotError(403, 'bot.forbidden', 'only the owner may add people');
        const role = String((req.body && req.body.role) || '');
        if (!['operator', 'viewer'].includes(role)) throw new BotError(422, 'bot.invalid_input', 'role must be operator or viewer');
        const username = String((req.body && req.body.username) || '').trim().replace(/^@/, '');
        if (!username) throw new BotError(422, 'bot.invalid_input', 'a username is required');
        if (!identity) throw new BotError(503, 'bot.network_unavailable', 'Network is not reachable to resolve that name');
        const user = await identity.byUsername(username);
        if (!user) throw new BotError(422, 'bot.unknown_user', `No OpenVibe account is called @${username}`);
        if (user.subject === me.subject) throw new BotError(422, 'bot.invalid_input', 'you are the owner of this robot');
        await domain.members.add(robot.id, user.subject, role, me.subject);
        res.redirect(303, `/panel/${robot.id}`);
    }));

    // The owner removes a person. The domain's delete never touches the owner row.
    r.post('/robots/:id/operators/:subject/remove', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        if (robot.owner_subject !== me.subject) throw new BotError(403, 'bot.forbidden', 'only the owner may remove people');
        await domain.members.remove(robot.id, req.params.subject);
        res.redirect(303, `/panel/${robot.id}`);
    }));

    // Leave the turn queue: anyone signed in, whether or not they are a member; the panels are told at once.
    r.post('/robots/:id/queue/leave', ...manage, express.urlencoded({ extended: false, limit: '1kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        await domain.queue.leave(robot.id, me.subject);
        if (hub) hub.broadcast(robot.id);
        res.redirect(303, `/panel/${robot.id}`);
    }));

    /** As the /control join decides: a member's role, or a place in the queue on a `queue` robot; else null. */
    async function memberRole(robot, me) {
        const role = await domain.members.roleOf(robot.id, me.subject);
        return role || (robot.access_policy === 'queue' ? 'queue' : null);
    }
    async function sendPanel(res, robot, profile, role, mode = 'page', signedIn = true, profileForm = {}) {
        await attachInProcess(robot, profile);
        const { maxCommandMs } = domain.control.effectiveLimits(robot, profile);
        // Two OpenRestream reads, run together. Only the owner's own page shows the streaming switches, greyed out
        // with a reason when OpenRestream does not answer; the live session is for the camera tile of every page,
        // where it is left a placeholder instead. A watcher is the anonymous embed and only exists when the
        // owner set embed_public — a private robot's video reaches no one else.
        const [streaming, signaling_url] = await Promise.all([
            role === 'owner' && mode === 'page'
                ? domain.streaming.get(robot.id).catch(() => ({ available: false, reason: 'unavailable', media: { on: false }, live: { on: false } }))
                : null,
            role === 'watcher' && !robot.embed_public
                ? null
                : domain.video.live(robot.id).catch((e) => { log.warn(`[Bot] live video for ${robot.id}: ${e.message}`); return null; }),
        ]);
        // The owner's People card: every member but the owner, with Network's name for each. A Network that
        // does not answer leaves the subject id and a note (see renderPanel) instead of failing the panel.
        const people = role === 'owner' && mode === 'page' ? await peopleFor(robot) : null;
        // The owner's routines and webhooks (server/routines.js, server/webhooks.js), with each hook's last delivery.
        let automation = null;
        if (role === 'owner' && mode === 'page' && routines && webhooks) {
            const hooks = await webhooks.list(robot.id);
            for (const h of hooks) { const d = (await webhooks.recent(h.id))[0]; h.last = d ? `${d.state}${d.last_status ? ` (${d.last_status})` : ''}` : null; }
            automation = { routines: await routines.list(robot.id), hooks, events: webhooks.EVENTS, describe: (t) => routines.describeTrigger(typeof t === 'string' ? JSON.parse(t) : t), ...(profileForm.automation || {}) };
        }
        res.type('html').send(renderPanel({
            robot: presentForPage(robot), profile, role, mode, signedIn, streaming, people, signaling_url,
            profileForm, automation,
            allowed_commands: role === 'watcher' ? [] : domain.control.allowedFor(robot, role, profile),
            // A held control is re-sent well inside the device's deadline, so it never stops between two frames.
            holdResendMs: Math.max(50, Math.min(HOLD_RESEND_MS, Math.floor(maxCommandMs / 2))),
        }));
    }

    // The owner can redraw button rows without JavaScript, save a validated robot-local profile, or return
    // to the catalogue source. The domain checks ownership too, so the write cannot bypass this route.
    r.post('/robots/:id/profile', ...manage, express.urlencoded({ extended: false, limit: '16kb' }), page(async (req, res) => {
        const me = requireUser(req);
        if (!sameOrigin(req)) throw new BotError(403, 'bot.forbidden', 'cross-site form posts are refused');
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        if (robot.owner_subject !== me.subject) throw new BotError(403, 'bot.forbidden', 'only the owner may edit buttons');
        const action = String(req.body.action || '');
        if (action === 'catalogue') {
            await domain.robots.useCatalogueProfile(robot.id, me);
            return res.redirect(303, `/panel/${robot.id}`);
        }
        const count = Number(req.body.count);
        if (!Number.isInteger(count) || count < 1 || count > 32) throw new BotError(422, 'bot.invalid_input', 'invalid button rows');
        const one = (key) => typeof req.body[key] === 'string' ? req.body[key].trim() : '';
        const rows = Array.from({ length: count }, (_, i) => ({
            name: one(`name_${i}`), label: one(`label_${i}`), key: one(`key_${i}`),
            cooldown: one(`cooldown_${i}`), hold: req.body[`hold_${i}`] === 'on',
        }));
        const state = { rows, point: req.body.point === 'on', pointCooldown: one('point_cooldown') };
        if (action === 'add') rows.push({ name: '', label: '', key: '', cooldown: '', hold: false });
        else if (/^remove:\d+$/.test(action)) {
            const i = Number(action.slice(7));
            if (i >= rows.length) throw new BotError(422, 'bot.invalid_input', 'invalid button row');
            rows.splice(i, 1);
        } else if (action !== 'save') throw new BotError(422, 'bot.invalid_input', 'invalid profile action');
        if (action !== 'save') {
            const local = await domain.robots.localProfile(robot.id);
            state.catalogueId = local ? local.source_profile_id : robot.profile_id;
            return sendPanel(res, robot, await profileOf(robot), 'owner', 'page', true, state);
        }
        try {
            const buttons = {};
            for (const row of rows) {
                if (!row.name && !row.label && !row.key && !row.cooldown && !row.hold) continue;
                if (!/^[a-z][a-z0-9_]{0,31}$/.test(row.name) || !row.label || Object.hasOwn(buttons, row.name))
                    throw new BotError(422, 'bot.invalid_input', 'each button needs a unique valid name and a label');
                if (row.cooldown && !/^(0|[1-9]\d*)$/.test(row.cooldown)) throw new BotError(422, 'bot.invalid_input', 'button cooldown must be whole milliseconds');
                buttons[row.name] = { label: row.label, ...(row.key ? { key: row.key } : {}),
                    ...(row.cooldown ? { cooldown_ms: Number(row.cooldown) } : {}), ...(row.hold ? { hold: true } : {}) };
            }
            if (state.pointCooldown && !/^(0|[1-9]\d*)$/.test(state.pointCooldown)) throw new BotError(422, 'bot.invalid_input', 'video click cooldown must be whole milliseconds');
            await domain.robots.saveLocalProfile(robot.id, me, { buttons,
                point: state.point ? { ...(state.pointCooldown ? { cooldown_ms: Number(state.pointCooldown) } : {}) } : null });
        } catch (e) {
            if (e.status !== 422) throw e;
            res.status(422);
            const local = await domain.robots.localProfile(robot.id);
            state.catalogueId = local ? local.source_profile_id : robot.profile_id;
            state.error = e.detail || e.message;
            return sendPanel(res, robot, await profileOf(robot), 'owner', 'page', true, state);
        }
        return res.redirect(303, `/panel/${robot.id}`);
    }));

    /** The non-owner members with their Network names, or null names when Network cannot be asked. */
    async function peopleFor(robot) {
        const members = (await domain.members.list(robot.id)).filter((m) => m.subject !== robot.owner_subject);
        let names = new Map();
        if (members.length && identity) {
            try { names = await identity.names(members.map((m) => m.subject)); }
            catch (e) { log.warn(`[Bot] names for ${robot.id}: ${e.message}`); }
        }
        return members.map((m) => {
            const n = names.get(m.subject);
            return { subject: m.subject, role: m.role, username: n ? n.username : null, display_name: n ? n.display_name : null };
        });
    }

    r.get('/panel/:id', page(async (req, res) => {
        // The panel page's own CSP (the live video's script and signaling sources, nothing else) replaces
        // the app's for this route only; every other page keeps `default-src 'self'`.
        res.setHeader('Content-Security-Policy', PANEL_CSP);
        const me = requireUser(req);
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        const role = await memberRole(robot, me);
        if (!role) throw new BotError(403, 'bot.not_an_operator', 'you have no access to this robot');
        const profile = await profileOf(robot);
        if (!profile) throw new BotError(404, 'bot.profile_not_found', 'this robot has no profile');
        const local = role === 'owner' ? await domain.robots.localProfile(robot.id) : null;
        await sendPanel(res, robot, profile, role, 'page', true, { catalogueId: local ? local.source_profile_id : robot.profile_id });
    }));

    // The embed's Drive (server/control-tickets.js): the popup page, first-party, signs in if it must and then mints a
    // ticket for the panel that opened it. Someone with no way onto the robot is told so here, not at the socket.
    r.get('/panel/:id/drive', page(async (req, res) => {
        const me = requireUser(req);
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        if (!await memberRole(robot, me)) throw new BotError(403, 'bot.not_an_operator', 'you have no access to drive this robot');
        res.type('html').send(renderDrivePage({ robot: domain.present.robot(robot) }));
    }));
    // A fetch from the popup itself only: the session cookie is SameSite=Lax, and the origin is checked as well.
    r.post('/panel/:id/ticket', ...manage, async (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            const site = req.headers['sec-fetch-site'];
            if (!sameOrigin(req) || (site && site !== 'same-origin')) throw new BotError(403, 'bot.forbidden', 'a ticket is minted only by openvibe.bot itself');
            const me = requireUser(req);
            const robot = await domain.robots.get(req.params.id);
            if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
            if (!await memberRole(robot, me)) throw new BotError(403, 'bot.not_an_operator', 'you have no access to drive this robot');
            const t = hub && hub.issueControlTicket(me, robot.id);
            if (!t) throw new BotError(503, 'bot.busy', 'try again in a moment');
            res.json({ ticket: t.ticket, robot_id: robot.id, expires_in: t.expires_in });
        } catch (e) {
            if (e.status && e.code) return res.status(e.status).json({ code: e.code, detail: e.detail || e.code });
            return next(e);
        }
        return undefined;
    });

    // The embed's own CSP replaces the app's for this route only; it sets no cookie and needs none to watch.
    r.get('/panel/:id/embed', page(async (req, res) => {
        res.setHeader('Content-Security-Policy', embedCsp(config));
        const robot = await domain.robots.get(req.params.id);
        if (!robot) throw new BotError(404, 'bot.robot_not_found', 'no such robot');
        let role = req.viewer ? await memberRole(robot, req.viewer) : null;
        if (!role && robot.embed_public) role = 'watcher';
        if (!role) return res.status(403).type('html').send(renderEmbedRefused({ robotId: robot.id }));
        const profile = await profileOf(robot);
        if (!profile) throw new BotError(404, 'bot.profile_not_found', 'this robot has no profile');
        return sendPanel(res, robot, profile, role, 'embed', !!req.viewer);
    }));

    return r;
}

module.exports = { createWebRoutes };
