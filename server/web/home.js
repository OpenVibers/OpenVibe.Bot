'use strict';

/**
 * The front page of openvibe.bot (GET /), served by Bot itself in place of the frozen OpenVibe.Sites page:
 * the OpenVibe Frame (openvibe-shared/shell: navbar, footer, theme) around openvibe-shared/showcase sections and
 * the page's own data sections (public/home.css).
 *
 * Every data section is real and server-rendered, and one with nothing to show is left out:
 *   - the catalogue (robot_profiles): the models Bot drives, how each connects, the numbers in the stat row;
 *   - the robots people list (robots.listed) with their online state, after the simulated rover anyone can drive;
 *   - the first kit's parts list (server/kits);
 *   - robotics jobs from OpenVibe.Search (OpenVibe.Work's documents), read anonymously and cached (web/network-reads.js).
 * The copy says only what works today (README "Owns" and "Devices").
 *
 *   renderHome({ config, signedIn, models, robots, kit, jobs })   the whole document
 *   HOME_CSP                                                       its Content-Security-Policy
 */
const shell = require('openvibe-shared/shell');
const showcase = require('openvibe-shared/showcase');
const kit = require('openvibe-shared/kit');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const appIcon = require('openvibe-shared/app-icon');
const seo = require('openvibe-shared/seo');
const { pickBlock, pickRules, foldBlock } = require('./short');

const SITE_NAME = 'OpenVibe.Bot';
const NETWORK_URL = 'https://openvibe.network';
const DESCRIPTION = 'An open control panel for robots: pair a robot with one pasted command and drive it from any browser, '
    + 'with roles, limits and an emergency stop on every command.';
const esc = showcase.esc;

/** The panel's own pages keep `default-src 'self'`; the front page also runs the OpenVibe Frame. */
const HOME_CSP = [
    "default-src 'self'",
    // The Frame's theme-loader, navbar and footer are served from /shared; the inline boot is the shell's.
    "script-src 'self' 'unsafe-inline' https://openvibe.network https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https://openvibe.network https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: https:",
    // The navbar asks the Network for the session, menus and notifications (events: realtime and release notices).
    "connect-src 'self' https://openvibe.network https://openvibe.events https://cloudflareinsights.com",
    "frame-src 'self' https://openvibe.network",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://openvibe.network",
].join('; ');

// How a robot reaches Bot, in the order a newcomer meets them (directory.CONNECT has the long words).
const KINDS = [
    ['browser', 'Simulated', 'No hardware at all: it runs inside Bot and in your browser.'],
    ['phone', 'A phone', 'The phone\'s browser is the robot: scan a code, allow the camera, keep the page open.'],
    ['onboard', 'On-board', 'The OpenVibe Node runs on the robot\'s own computer, such as a Raspberry Pi, and drives its hardware.'],
    ['bridge', 'Bridge', 'The Node runs on a computer next to the robot and joins the robot\'s own link. Nothing on the robot changes.'],
    ['server', 'Server-side', 'Nothing to install: Bot connects to the device itself, like an ONVIF camera.'],
];
// directory.js requires this module for framePage, so its words are read when a page renders, not at load.
const capWord = (c) => require('./directory').CAPABILITY_WORDS[c] || c;
const POLICY_WORDS = { private: 'Its owner and the people they add drive it', invite: 'People the owner invites drive it', queue: 'Anyone signed in can take a turn' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const link = (href, text, cls = '') => `<a${cls ? ` class="${cls}"` : ''} href="${esc(href)}"${/^https?:/.test(href) ? ' rel="noopener"' : ''}>${esc(text)}</a>`;
const sec = (id, title, lede, inner, more = '') => `<section class="sc-sec hm-sec" id="${id}" aria-labelledby="${id}-h"><div class="hm-head"><h2 id="${id}-h">${esc(title)}</h2>${more}</div>${lede ? `<p class="sc-lede">${esc(lede)}</p>` : ''}${inner}</section>`;

/** The model's first sentence, cut near `max` characters at a word. */
function short(text, max = 120) {
    const first = String(text || '').split(/(?<=[.:;])\s/)[0].replace(/[:;]$/, '.');
    if (first.length <= max) return /[.!?]$/.test(first) || !first ? first : `${first}.`;
    return `${first.slice(0, first.lastIndexOf(' ', max)).replace(/[,(]$/, '')}…`;
}

function hero({ signedIn, config }) {
    const install = `curl -fsSL ${config.installer.scriptUrl} | sh`;
    const aside = `<div class="hm-term" role="group" aria-label="Get a robot online">
<p class="hm-term-top"><span></span><span></span><span></span><b>On the robot's computer</b></p>
<pre tabindex="0"><code><span class="hm-prompt">$</span> ${esc(install)}</code></pre>
<ol class="hm-term-steps"><li>It finds the kit and shows a short code.</li><li>Approve the code at ${link('/link', 'openvibe.bot/link')}.</li><li>Open the robot's panel and drive.</li></ol>
<p class="hm-term-foot">Raspberry Pi OS or any Linux. A blank microSD card? ${link('/setup/sd-card', 'Make its setup files')}, no screen needed.</p></div>`;
    return showcase.hero({
        eyebrow: 'OpenVibe.Bot · alpha',
        title: 'Drive your robot', accent: 'from any browser.',
        lede: 'An open control panel for robots. Pair a robot with one pasted command, then drive it with a touch joystick, '
            + 'the keyboard or a gamepad. Every command passes one gate, with roles, limits and an emergency stop that only you clear.',
        // Two, so they sit side by side on a phone; how it works is the steps a scroll below.
        actions: signedIn
            ? [{ label: 'Your robots', href: '/robots', primary: true }, { label: 'Try the panel', href: '/try' }]
            : [{ label: 'Try it now, no account', href: '/try', primary: true }, { label: 'Sign in with OpenVibe', href: '/auth/login?next=%2Frobots' }],
        note: 'Alpha. A paired robot sends its camera over WebRTC to OpenRestream and the panel plays it live; the first supported kit is the Adeept 4WD Smart Car for Raspberry Pi.',
        aside: { html: aside },
    });
}

/** Numbers that come straight from the catalogue and the directory: one strip (it scrolls sideways on a phone). */
function stats({ models, robots }) {
    if (!models.length) return '';
    const community = models.filter((m) => m.community).length;
    const kinds = new Set(models.map((m) => m.connect)).size;
    const caps = new Set(models.flatMap((m) => m.capabilities)).size;
    const online = robots.filter((r) => r.online).length;
    return `<section class="sc-sec hm-sec hm-stats-sec" aria-label="OpenVibe.Bot in numbers">${kit.stats([
        [models.length, models.length === 1 ? 'robot model' : 'robot models', '/models'],
        [kinds, kinds === 1 ? 'way to connect' : 'ways to connect', '#connect'],
        [caps, caps === 1 ? 'kind of control' : 'kinds of control', '#models'],
        community ? [community, community === 1 ? 'community profile' : 'community profiles', '/models#g-community'] : null,
        online ? [online, online === 1 ? 'listed robot online' : 'listed robots online', '#now'] : null,
    ].filter(Boolean), { label: 'OpenVibe.Bot in numbers' })}</section>`;
}

/** The simulated rover anyone can drive, then the robots people list (online first), as one rail. */
function onlineNow({ robots }) {
    const sim = kit.card({ href: '/try', title: 'Simulated rover', type: 'game', ratio: '16/9', badge: 'Online', sub: 'Camera, range finder, line sensors, lights, horn', who: 'Anyone, no account', share: false });
    const cards = robots.slice(0, 8).map((r) => kit.card({ href: `/r/${r.id}`, title: r.name, type: 'game', ratio: '16/9', badge: r.online ? 'Online' : 'Offline', sub: `${r.model_name}${r.owner && r.owner.username ? ` · @${r.owner.username}` : ''}`, who: POLICY_WORDS[r.access_policy] || '', share: false }));
    return `<section class="sc-sec hm-sec" id="now">${kit.rail({ id: 'now-rail', title: 'Drive one now', more: { href: '/robots', label: robots.length ? 'The directory' : 'Browse robots' }, items: [sim].concat(cards), wrap: true })}</section>`;
}

function modelsSection({ models }) {
    if (!models.length) return '';
    const kindOf = (m) => (KINDS.find((k) => k[0] === m.connect) || [, m.connect])[1];
    const cards = models.map((m) => kit.card({ href: `/models/${m.id}`, title: m.name, type: 'game', ratio: '16/9', badge: kindOf(m), sub: m.capabilities.slice(0, 3).map(capWord).join(' · '), peek: short(m.description), share: false }));
    return `<section class="sc-sec hm-sec" id="models">${kit.rail({ id: 'models-rail', title: 'Robots it drives today', more: { href: '/models', label: `All ${models.length} models` }, items: cards, wrap: true })}
<p class="hm-under">Each has a profile the panel draws its controls from: a joystick for a base that drives, sliders for a pan-tilt head, buttons for lights and a horn.</p></section>`;
}

/** The connection kinds as one list, each with how many models use it. */
function connectSection({ models, rules }) {
    const groups = KINDS.map(([k, label, text]) => ({ k, label, text, ms: models.filter((m) => m.connect === k) })).filter((g) => g.ms.length);
    if (!groups.length) return '';
    const n = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'][groups.length] || String(groups.length);
    // The ways to connect are blocks of the same kind: on a phone a row of chips picks one of them and the chip names
    // it, so the list is one way at a time. Every way stays in the page.
    const panes = groups.map((g) => ({
        id: g.k,
        label: g.label,
        html: kit.list([kit.row({ href: g.ms.length === 1 ? `/models/${g.ms[0].id}` : `/models#k-${g.k}`, title: g.label, sub: g.text, meta: plural(g.ms.length, 'model', 'models') })]),
    }));
    if (rules) rules.push(pickRules('connect', panes.map((p) => p.id)));
    return sec('connect', `${n} ${groups.length === 1 ? 'way' : 'ways'} to connect, one panel`, 'However a robot reaches OpenVibe, it gets the same panel, the same gate and the same emergency stop.',
        pickBlock({ key: 'connect', label: 'The ways to connect', head: `${n} ${groups.length === 1 ? 'way' : 'ways'} to connect, one panel`, panes }));
}

function startSection() {
    return foldBlock({
        id: 'how',
        head: '<h2 id="how-h">Online in a minute</h2>',
        html: showcase.steps({
        id: 'how',
        title: 'Online in a minute',
        lede: 'The robot connects out to OpenVibe, so there are no ports to open on your router and no stock control server left exposed.',
        items: [
            { title: 'Run one command on the robot', text: 'Paste the installer line on its Raspberry Pi or Linux computer. It installs the OpenVibe Node, finds the kit and shows a short code.' },
            { title: 'Approve it', text: 'Sign in at openvibe.bot/link and enter the code. The robot\'s credential is stored hashed, and you can revoke it any time.' },
            { title: 'Drive it', text: 'Open the robot\'s panel in any browser, phone included. Share it, list it, or bind it to your OpenVibe.Live channel.' },
        ],
        }),
    });
}

// The parts people read once fold away: what the panel does, automation, your computers, the API, the kit, building.
const rows = (items) => kit.list(items.map(([href, title, text]) => kit.row({ href, title, sub: text, rel: /^https?:/.test(href) ? 'noopener' : '' })), { flush: true });
function moreSection({ config, kit: k, models }) {
    const base = config.baseUrl;
    const panel = rows([
        ['/try', 'Real controls', 'A touch joystick, the keyboard or a gamepad, plus buttons and sliders, laid out from the robot\'s profile, with a latency meter.'],
        ['/docs/profiles', 'Safe by default', 'Per-robot limits, cooldowns and a turn budget on every command; a latched emergency stop that only the owner clears; a halt always gets through.'],
        ['/robots', 'Every command on the record', 'Allowed or refused, each command is audited and kept for 30 days.'],
        ['/robots', 'Share control', 'Add people by @username as operators or viewers, or open a queue where visitors take turns.'],
        ['https://openvibe.live/', 'Show it on your channel', 'Bind the robot to your OpenVibe.Live channel: its panel shows under your stream, and anyone allowed takes the controls there.'],
    ]);
    const automate = rows([
        ['/docs/automation', 'Routines', 'Plain step lines such as forward 2, wait 1, say Hello, on demand, on a schedule, or each time the robot comes online.'],
        ['/docs/automation', 'Signed webhooks', 'Online, offline, e-stop and refused commands sent to your own https address, signed like OpenVibe.Events deliveries.'],
        ['https://openvibe.actor/', 'Your agent drives', 'Turn on Your agent and your OpenVibe.Actor agent can run steps on that robot, as you and nobody else.'],
    ]);
    const computers = rows([
        ['/docs/computers#desks-h', 'A desk for each task', 'Your agents work on desks of their own on your computer, a browser or a whole screen, never yours. Watch any of them live and take it over.'],
        ['/machines', 'A spare computer as a desk host', 'An old laptop or a mini PC hosts desks for all your agents\' tasks, with no screen or sign-in, sized to its memory.'],
        ['/docs/computers#models-c-h', 'Your own AI models', 'Ollama, LM Studio or llama.cpp on your computer answers your Vibe, your AI members and your stream\'s AI viewers: free, and no port is opened.'],
        ['/docs/computers', 'A desk live on your channel', 'When you choose, an agent\'s desk shows on your OpenVibe Live channel for up to 30 minutes, so people can watch it work.'],
    ]);
    const api = showcase.code({
        id: 'api', title: '', lede: 'A REST API and the openvibe-sdk client, held to the same roles, limits and emergency stop as the panel. Profiles and kits are public reads.',
        samples: [
            { label: 'JavaScript (openvibe-sdk)', lang: 'js', code: "import { createClient } from 'openvibe-sdk/core';\nimport { createBotClient } from 'openvibe-sdk/bot';\n\nconst bot = createBotClient(createClient({ credentials: 'include' }));\nconst { robots } = await bot.robots.list();\n\n// Half speed ahead for 300 ms, same gate as the joystick\nawait bot.robots.command(robots[0].id, {\n    kind: 'drive', value: { throttle: 0.5, steer: 0 }, ms: 300,\n});" },
            { label: 'Public reads (curl)', lang: 'sh', code: `# Every robot model and its controls\ncurl ${base}/api/v1/profiles\n\n# The kits, with their parts lists\ncurl ${base}/api/v1/kits` },
        ],
    });
    const model = k ? models.find((m) => m.id === k.profile_id) : null;
    const kitBody = k && k.parts && k.parts.length
        ? `<p class="hm-fold-lede">What to get for the robot OpenVibe.Bot was built around. The OpenVibe Node drives its Robot HAT directly, publishes the Pi camera and stops the motors the moment commands stop.</p><ul class="hm-parts">${k.parts.map((p) => `<li><b>${esc(p.qty || 1)}×</b><span>${esc(p.name)}${p.note ? `<small>${esc(p.note)}</small>` : ''}</span></li>`).join('')}</ul>
<p class="hm-kit-actions">${link(k.build_guide_url, 'Adeept\'s build guide', 'sc-btn')}${model ? ` ${link(`/models/${model.id}`, 'Its model page', 'sc-btn')}` : ''} ${link('https://github.com/OpenVibers/OpenVibe.Node/blob/main/docs/hardware-adeept.md', 'Setup guide for the Node', 'sc-btn')}</p>`
        : '';
    const build = rows([
        ['/docs/drivers', 'Write a driver', 'A separate program in any language that speaks JSON lines with the OpenVibe Node: every message and the safety rules.'],
        ['/docs/profiles', 'Robot profiles', 'The JSON that says what a robot can do and which controls its panel shows, with a validator.'],
        ['/robots/submit', 'Submit a robot', 'Describe your robot with a profile and point at its driver. Once reviewed, anyone can add one.'],
        ['https://github.com/OpenVibers/OpenVibe.Bot', 'The source', 'OpenVibe.Bot and the OpenVibe Node are open source under the AGPL-3.0.'],
    ]);
    return foldBlock({
        id: 'more',
        head: '<h2 id="more-h" class="hm-h">More on OpenVibe.Bot</h2>',
        html: `<section class="sc-sec hm-sec hm-more-sec" id="more" aria-labelledby="more-h"><h2 class="hm-h">More on OpenVibe.Bot</h2>
${kit.fold({ id: 'panel', title: 'What the panel does', meta: 'controls, safety, sharing', body: panel })}
${kit.fold({ id: 'automate', title: 'Let it run without you', meta: 'routines, webhooks, your agent', body: `<p class="hm-fold-lede">They all go through the gate a person does: the same limits, the same e-stop, the same audit.</p>${automate}` })}
${kit.fold({ id: 'computers', title: 'Your computers, for your agents and your AI', meta: 'the same Node', body: `<p class="hm-fold-lede">The same OpenVibe Node runs on your own computers. It connects out, nobody else's work reaches them, and the limits you set on each computer always win.</p>${computers}` })}
${kit.fold({ id: 'code', title: 'The same robot from your own code', meta: 'REST and the SDK', body: api })}
${kitBody ? kit.fold({ id: 'kit', title: `The first kit: ${k.name}`, meta: plural(k.parts.length, 'part', 'parts'), body: kitBody }) : ''}
${kit.fold({ id: 'build', title: 'Build for OpenVibe.Bot', meta: 'drivers, profiles, the source', body: `${build}<p class="hm-fold-lede">${link('/docs', 'All build pages', 'hm-more')}</p>` })}</section>`,
    });
}

function jobsSection({ jobs }) {
    if (!jobs || !jobs.length) return '';
    return foldBlock({
        id: 'jobs',
        head: '<h2 id="jobs-h">Robotics jobs on OpenVibe.Work</h2>',
        html: `<section class="sc-sec hm-sec" id="jobs">${kit.list(jobs.slice(0, 3).map((j) => kit.row({ href: j.url, rel: 'noopener', title: j.title, sub: [j.location, j.remote ? 'Remote' : '', j.type].filter(Boolean).join(' · ') })), { title: 'Robotics jobs on OpenVibe.Work', more: { href: 'https://openvibe.work/jobs?q=robotics', label: 'More jobs' } })}</section>`,
    });
}

/** Questions people ask first, answered from what Bot does today; the model list comes from the catalogue. */
function faqItems({ models }) {
    const names = models.filter((m) => !m.community).map((m) => m.name);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '';
    return [
        { q: 'Do I need to open ports on my router?', a: 'No. The robot\'s computer connects out to OpenVibe, so it works behind an ordinary home or mobile connection. The Adeept kit\'s own control server, with its fixed password, is never run.' },
        { q: 'Can I try it without a robot?', a: 'Yes. The simulated rover at openvibe.bot/try runs in your browser with no account and no hardware, through the same panel a paired robot gets.' },
        list ? { q: 'Which robots work today?', a: `${list}. Each has a profile the panel draws its controls from, and anything a local script can switch works through the relay robot.` } : null,
        { q: 'How does it keep the robot safe?', a: 'Every command passes one gate with roles, per-robot limits, cooldowns and a turn budget. The emergency stop is latched until the owner clears it, a stop pressed on the robot holds until it is released there, and the device stops its motors by itself when commands stop arriving.' },
        { q: 'Can other people drive my robot?', a: 'Only if you say so. Add people by @username as operators or viewers, or open a queue where signed-in visitors take timed turns. Listing a robot in the directory lets anyone watch it.' },
        { q: 'Can I show it on my stream?', a: 'Yes. Bind the robot to your OpenVibe.Live channel and its panel shows under your stream, where anyone you allow can take the controls.' },
        { q: 'Can my AI agent drive it?', a: 'Only when you turn on Your agent for that robot. Then your OpenVibe.Actor agent can read its state and run steps as you, through the same gate, and for nobody else.' },
        { q: 'Can my agents use my computer?', a: 'Only if you install the OpenVibe Node there and say so. Each agent task gets a desk of its own, a browser or a whole screen, that you can watch and take over, at the level you set on the computer, with a kill switch there. A spare computer can host the desks instead.' },
        { q: 'Can my AI use the models on my computer?', a: 'Yes. Install the Node with --ai where Ollama, LM Studio or llama.cpp runs and turn on "Let my AI use this computer\'s models": your Vibe, your AI members and your stream\'s AI viewers can then think with them, free, and only for you.' },
        { q: 'Is it open source?', a: 'Yes. OpenVibe.Bot and the OpenVibe Node that runs on the robot are on GitHub under the AGPL-3.0, and anyone can write a driver or submit a robot profile.' },
    ].filter(Boolean);
}

/** The questions, closed until opened (showcase.faq). */
function faqSection(items) {
    return foldBlock({
        id: 'faq',
        head: '<h2 id="faq-h">Questions</h2>',
        html: `<section class="sc-sec hm-sec" id="faq">${showcase.faq({ id: 'faq-list', title: 'Questions', items: items.map((x) => [x.q, x.a]) })}</section>`,
    });
}

function sections({ signedIn = false, config, models = [], robots = [], kit: k = null, jobs = [], faq = null, rules = null } = {}) {
    return hero({ signedIn, config })
        + stats({ models, robots })
        + onlineNow({ robots })
        + modelsSection({ models })
        + connectSection({ models, rules })
        + startSection()
        + moreSection({ config, kit: k, models })
        + jobsSection({ jobs })
        + faqSection(faq || faqItems({ models }))
        + foldBlock({
            id: 'network',
            head: '<h2 id="network-h">Part of OpenVibe</h2>',
            html: showcase.network({ service: 'bot' }),
        });
}

/** The OpenVibe Frame around one of Bot's public pages (the front page, the Build docs): navbar, footer, theme. */
function framePage({ config, title, description, canonicalPath = '/', body, head = '' }) {
    const nav = {
        service: 'bot',
        apiBase: NETWORK_URL,
        links: [{ label: 'Robots', href: '/robots' }, { label: 'Build', href: '/docs' }],
        history: { type: 'page', title },
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',
        logoutUrl: '/auth/logout?next={path}',
        notificationsRealtime: true,
    };
    return shell.page({
        name: SITE_NAME, service: 'bot', lang: 'en', title, siteName: SITE_NAME, description, summary: description,
        canonical: `${config.baseUrl}${canonicalPath}`, robots: 'index, follow',
        agentLayer: require('../agent-pages').TWIN_PATH_RE.test(canonicalPath), llms: '/llms.txt',
        navbar: nav, footer: { service: 'bot', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' }, home: '/',
        navLinks: [{ label: 'Robots', href: '/robots' }, { label: 'Build', href: '/docs' }],
        head: [appIcon.headTags({ site: 'bot' }), '<link rel="manifest" href="/manifest.webmanifest">', `<link rel="apple-touch-icon" href="${require('openvibe-shared/app-icons').url('bot', 192)}">`, head].filter(Boolean).join('\n'),
        body: `<div id="navbar-mount"></div>\n${body}`,
    });
}

/** /updates: what shipped on OpenVibe.Bot, the network's shared update log (openvibe-shared/frame updatesBody). */
function renderUpdates({ config }) {
    return framePage({
        config, title: `What shipped on ${SITE_NAME}`, description: `Every change deployed to ${SITE_NAME}, newest first.`, canonicalPath: '/updates',
        body: `<main id="main" class="page">\n${frame.updatesBody({ service: 'bot', siteName: SITE_NAME })}\n</main>\n<script src="${ovServe.url('shipped.js')}" defer></script>`,
    });
}

function renderHome({ config, signedIn = false, models = [], robots = [], kit = null, jobs = [] }) {
    const nav = {
        service: 'bot',
        apiBase: NETWORK_URL,
        links: [{ label: 'Robots', href: '/robots' }, { label: 'Build', href: '/docs' }],
        history: { type: 'page', title: SITE_NAME },
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',
        logoutUrl: '/auth/logout?next={path}',
        notificationsRealtime: true,
    };
    const footer = { service: 'bot', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME };
    const url = `${config.baseUrl}/`;
    // The rules that show the picked block of the pick block are written for this page.
    const rules = [];
    const faq = faqItems({ models });
    const body = sections({ signedIn, config, models, robots, kit, jobs, faq, rules });
    return shell.page({
        name: SITE_NAME, service: 'bot', lang: 'en',
        title: `${SITE_NAME}: drive your robot from any browser`,
        siteName: SITE_NAME,
        description: DESCRIPTION,
        summary: DESCRIPTION,
        canonical: url,
        robots: 'index, follow',
        agentLayer: true, llms: '/llms.txt',
        jsonLd: [
            seo.jsonLd.website({ name: SITE_NAME, url, description: DESCRIPTION }),
            seo.jsonLd.softwareApp({ name: SITE_NAME, url, description: DESCRIPTION, category: 'UtilitiesApplication', keywords: ['robot control panel', 'Raspberry Pi robot', 'ROS 2', 'Cozmo', 'telepresence'] }),
            models.length ? seo.jsonLd.itemList('Robots OpenVibe.Bot drives', models.map((m) => ({ name: m.name, url: `${config.baseUrl}/models/${m.id}`, description: short(m.description, 160) })), { url }) : null,
            seo.jsonLd.faq(faq.map((f) => ({ q: f.q, a: f.a }))),
        ].filter(Boolean),
        navbar: nav, footer, home: '/', navLinks: [{ label: 'Robots', href: '/robots' }, { label: 'Build', href: '/docs' }],
        head: [
            appIcon.headTags({ site: 'bot' }),
            '<link rel="manifest" href="/manifest.webmanifest">', `<link rel="apple-touch-icon" href="${require('openvibe-shared/app-icons').url('bot', 192)}">`,
            `<link rel="stylesheet" href="${ovServe.url('kit.css')}">`,
            `<link rel="stylesheet" href="${ovServe.url('room.css')}">`,
            `<link rel="stylesheet" href="${ovServe.url(showcase.STYLESHEET)}">`,
            '<link rel="stylesheet" href="/home.css">',
            rules.length ? `<style>@supports selector(:has(*)){@media (max-width:640px){${rules.join('')}}</style>` : '',
        ].join('\n'),
        body: `<div id="navbar-mount"></div>
<main id="main" class="page hm">
${body}
</main>`,
    });
}

module.exports = { renderHome, renderUpdates, framePage, HOME_CSP, sections, faqItems };
