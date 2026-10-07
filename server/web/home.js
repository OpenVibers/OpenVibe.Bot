'use strict';

/**
 * The front page of openvibe.bot (GET /), served by Bot itself in place of the frozen OpenVibe.Sites page:
 * the OpenVibe Frame (openvibe-shared/shell: navbar, footer, theme) around openvibe-shared/showcase sections.
 *
 * The copy says only what works today (README "Owns" and "Devices"): pairing with one pasted command, the
 * panel's controls, the command gate and the latched e-stop, people and the queue, the read-only embed, the
 * simulator, and the kits Bot has drivers for. Live video in the panel waits for OpenRe.Stream to play a
 * WHIP-published stream back, and the page says so rather than showing it.
 *
 *   renderHome({ config, signedIn })   the whole document
 *   HOME_CSP                           its Content-Security-Policy (the Frame's scripts and calls to the Network)
 */
const shell = require('openvibe-shared/shell');
const showcase = require('openvibe-shared/showcase');
const ovServe = require('openvibe-shared/serve');
const appIcon = require('openvibe-shared/app-icon');

const SITE_NAME = 'OpenVibe.Bot';
const NETWORK_URL = 'https://openvibe.network';
const DESCRIPTION = 'An open control panel for robots: pair a robot with one pasted command and drive it from any browser, '
    + 'with roles, limits and an emergency stop on every command.';

/** The panel's own pages keep `default-src 'self'`; the front page also runs the OpenVibe Frame. */
const HOME_CSP = [
    "default-src 'self'",
    // The Frame's theme-loader, navbar and footer are served from /shared; the inline boot is the shell's.
    "script-src 'self' 'unsafe-inline' https://openvibe.network",
    "style-src 'self' 'unsafe-inline' https://openvibe.network https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: https:",
    // The navbar asks the Network for the session, menus and notifications (events: realtime and release notices).
    "connect-src 'self' https://openvibe.network https://openvibe.events",
    "frame-src 'self' https://openvibe.network",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://openvibe.network",
].join('; ');

function sections({ signedIn }) {
    return showcase.hero({
        eyebrow: 'OpenVibe.Bot · alpha',
        title: 'Drive your robot', accent: 'from any browser.',
        lede: 'An open control panel for robots. Add a robot, pair it with one pasted command, and drive it with a touch joystick, '
            + 'the keyboard or a gamepad. Every command passes one gate, with roles, limits and an emergency stop that only you clear.',
        actions: signedIn
            ? [{ label: 'Your robots', href: '/robots', primary: true }, { label: 'How it works', href: '#how' }]
            : [{ label: 'Sign in with OpenVibe', href: '/auth/login?next=%2Frobots', primary: true }, { label: 'How it works', href: '#how' }],
        note: 'Alpha. A paired robot sends its camera over WebRTC to OpenRe.Stream and the panel plays it live; the first supported kit is the Adeept 4WD Smart Car for Raspberry Pi.',
    }) + showcase.steps({
        id: 'how',
        title: 'Online in three steps',
        lede: 'The robot connects out to OpenVibe, so there are no ports to open on your router.',
        items: [
            { title: 'Add a robot', text: 'Name it and pick its profile. A simulated rover works straight away, before any hardware exists.' },
            { title: 'Pair it', text: 'Paste one command on the robot\'s computer. It installs the OpenVibe device agent with a one-time code; the robot\'s credential is stored hashed and can be revoked any time.' },
            { title: 'Drive it', text: 'Open the robot\'s panel in any browser, phone included.' },
        ],
    }) + showcase.features({
        title: 'What the panel does',
        items: [
            { icon: 'ov:games', title: 'Real controls', text: 'A touch joystick, the keyboard or a gamepad, plus buttons and sliders, laid out from the robot\'s profile, with a latency meter.' },
            { icon: 'ov:error', title: 'Safe by default', text: 'Per-robot limits, cooldowns and a turn budget on every command. The emergency stop is latched: only the owner clears it, and a halt always gets through.' },
            { icon: 'ov:history', title: 'Every command on the record', text: 'Allowed or refused, each command is audited and kept for 30 days.' },
            { icon: 'ov:account', title: 'Share control', text: 'Add people by @username as operators or viewers, or open a queue where visitors take turns.' },
            { icon: 'ov:live', title: 'Show it on your channel', text: 'Let OpenVibe.Live frame the robot\'s read-only panel, so viewers follow its state as someone drives it.' },
            { icon: 'ov:code', title: 'An API with the same gate', text: 'A REST API for your own apps, held to the same roles, limits and e-stop as the panel.' },
        ],
    }) + showcase.features({
        title: 'Robots it drives today',
        items: [
            { icon: 'ov:check', title: 'Adeept 4WD Smart Car', text: 'The Raspberry Pi kit, with its parts list and build guide; a mecanum-wheel build has its own profile. The first robot on OpenVibe.Bot.' },
            { icon: 'ov:check', title: 'Cozmo', text: 'Through the device agent on a computer next to it.' },
            { icon: 'ov:check', title: 'A simulated rover', text: 'Runs inside Bot, so you can try the whole panel with no hardware.' },
        ],
    });
}

function renderHome({ config, signedIn = false }) {
    const nav = {
        service: 'bot',
        apiBase: NETWORK_URL,
        links: [{ label: 'Robots', href: '/robots' }],
        history: { type: 'page', title: SITE_NAME },
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',
        logoutUrl: '/auth/logout?next={path}',
        notificationsRealtime: true,
    };
    const footer = { service: 'bot', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME };
    return shell.page({
        name: SITE_NAME, service: 'bot', lang: 'en',
        title: `${SITE_NAME}: drive your robot from any browser`,
        siteName: SITE_NAME,
        description: DESCRIPTION,
        summary: DESCRIPTION,
        canonical: `${config.baseUrl}/`,
        robots: 'index, follow',
        navbar: nav, footer, home: '/', navLinks: [{ label: 'Robots', href: '/robots' }],
        head: [
            appIcon.headTags({ site: 'bot' }),
            '<link rel="manifest" href="/manifest.webmanifest">',
            `<link rel="stylesheet" href="${ovServe.url(showcase.STYLESHEET)}">`,
        ].join('\n'),
        body: `<div id="navbar-mount"></div>
<main id="main" class="page">
${sections({ signedIn })}
</main>`,
    });
}

module.exports = { renderHome, HOME_CSP, sections };
