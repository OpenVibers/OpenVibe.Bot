'use strict';
/**
 * GET /setup/sd-card: a robot from a blank microSD card (owner 2026-10-24: "if you just have a fresh MicroSD card how to
 * flash … and be able to connect to the device headlessly … the site needs to guide the user").
 *
 * One page, four steps: describe the robot and the Wi-Fi (the form), write Raspberry Pi OS Lite with Raspberry Pi
 * Imager, copy the two files this page makes onto the card, switch the robot on and watch it arrive. public/sd-card.js
 * makes the files in the browser (the Wi-Fi and login passwords never leave it) with a setup key from
 * POST /setup/sd-card/keys (server/setup-keys.js); the card's first boot runs the installer with that key and the robot
 * adds itself, approved, with no code on a screen.
 */
const { esc } = require('./render');
const { framePage } = require('./home');

const POLICIES = [['private', 'Only me and people I add'], ['invite', 'People I invite'], ['queue', 'Anyone signed in, taking turns']];
// Wi-Fi countries (the regulatory domain the Pi's radio must use): the common ones first, then the rest of the list.
const COUNTRIES = [['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['IE', 'Ireland'],
    ['DE', 'Germany'], ['FR', 'France'], ['ES', 'Spain'], ['IT', 'Italy'], ['NL', 'Netherlands'], ['BE', 'Belgium'], ['CH', 'Switzerland'], ['AT', 'Austria'],
    ['SE', 'Sweden'], ['NO', 'Norway'], ['DK', 'Denmark'], ['FI', 'Finland'], ['PL', 'Poland'], ['PT', 'Portugal'], ['GR', 'Greece'], ['CZ', 'Czechia'],
    ['BR', 'Brazil'], ['MX', 'Mexico'], ['AR', 'Argentina'], ['CL', 'Chile'], ['CO', 'Colombia'], ['JP', 'Japan'], ['KR', 'South Korea'], ['CN', 'China'],
    ['TW', 'Taiwan'], ['HK', 'Hong Kong'], ['SG', 'Singapore'], ['IN', 'India'], ['PH', 'Philippines'], ['ID', 'Indonesia'], ['MY', 'Malaysia'], ['TH', 'Thailand'],
    ['VN', 'Vietnam'], ['ZA', 'South Africa'], ['NG', 'Nigeria'], ['KE', 'Kenya'], ['EG', 'Egypt'], ['IL', 'Israel'], ['TR', 'Turkey'], ['AE', 'United Arab Emirates'],
    ['SA', 'Saudi Arabia'], ['UA', 'Ukraine'], ['RO', 'Romania'], ['HU', 'Hungary']];

const link = (href, text) => `<a href="${esc(href)}"${/^https?:/.test(href) ? ' rel="noopener"' : ''}>${esc(text)}</a>`;

function renderSdCard({ config, signedIn = false, models = [], values = {} }) {
    const chosen = models.some((m) => m.id === values.profile_id) ? values.profile_id : (models.find((m) => /adeept/.test(m.id)) || models[0] || {}).id;
    const installer = `curl -fsSL ${config.installer.scriptUrl} | sh`;
    const form = signedIn ? `<form id="sd-form" class="dir-form sd-form" data-server="${esc(config.baseUrl)}" novalidate>
<p class="dir-error" id="sd-error" role="alert" tabindex="-1" hidden></p>
<fieldset class="dir-fieldset"><legend class="sd-legend">The robot</legend>
<label class="dir-field"><span class="dir-field-label">Name</span><input type="text" name="name" maxlength="80" required autocomplete="off" placeholder="e.g. Mecanum rover" value="${esc(values.name || '')}"></label>
<label class="dir-field"><span class="dir-field-label">Model</span><select name="profile_id">${models.map((m) => `<option value="${esc(m.id)}"${m.id === chosen ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
<label class="dir-field"><span class="dir-field-label">Who may drive</span><select name="access_policy">${POLICIES.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>
<label class="sd-check"><input type="checkbox" name="live" value="on" checked> <span>Show its camera on my OpenVibe.Live channel once it is online</span></label>
</fieldset>
<fieldset class="dir-fieldset"><legend class="sd-legend">Your Wi-Fi</legend>
<label class="dir-field"><span class="dir-field-label">Network name</span><input type="text" name="wifi_ssid" maxlength="32" required autocomplete="off" spellcheck="false"></label>
<label class="dir-field"><span class="dir-field-label">Password</span><input type="password" name="wifi_password" maxlength="63" autocomplete="off"></label>
<label class="dir-field"><span class="dir-field-label">Country</span><select name="wifi_country">${COUNTRIES.map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join('')}</select></label>
<label class="sd-check"><input type="checkbox" name="wifi_hidden" value="on"> <span>The network is hidden (it does not show in Wi-Fi lists)</span></label>
</fieldset>
<fieldset class="dir-fieldset"><legend class="sd-legend">A login on the robot (for SSH, or a keyboard and screen)</legend>
<label class="dir-field"><span class="dir-field-label">Username</span><input type="text" name="username" maxlength="32" required autocomplete="off" spellcheck="false" autocapitalize="none" value="robot"></label>
<label class="dir-field"><span class="dir-field-label">Password</span><input type="password" name="password" minlength="8" required autocomplete="new-password"></label>
<label class="dir-field"><span class="dir-field-label">Password again</span><input type="password" name="password2" minlength="8" required autocomplete="new-password"></label>
<details class="sd-more"><summary>More: the hostname, an SSH key</summary>
<label class="dir-field"><span class="dir-field-label">Hostname</span><input type="text" name="hostname" maxlength="63" autocomplete="off" spellcheck="false" autocapitalize="none" pattern="[a-z0-9-]+"></label>
<p class="muted dir-note">You reach the robot at <code>&lt;hostname&gt;.local</code> on your network. Made from the name unless you change it.</p>
<label class="dir-field dir-wide"><span class="dir-field-label">SSH public keys (optional, one per line)</span><textarea name="ssh_keys" rows="3" spellcheck="false" placeholder="ssh-ed25519 AAAA… you@laptop"></textarea></label>
</details>
<input type="hidden" name="timezone" value="">
</fieldset>
<p class="sd-private">Your Wi-Fi password and the login password stay in this browser. They go only into the files you download, never to openvibe.bot (the password is stored hashed, as Raspberry Pi Imager does).</p>
<p><button type="submit" class="dir-btn dir-primary">Make my card files</button></p>
</form>`
        : `<p class="sd-signin">${link('/auth/login?next=%2Fsetup%2Fsd-card', 'Sign in')} to make your card's files: they add the robot to your account.</p>`;

    const body = `<p class="dir-crumb">${link('/robots', 'Robots')} · ${link('/robots/new', 'Add a robot')}</p>
<header class="dir-hero"><h1>A robot from a blank microSD card</h1>
<p class="muted">No screen, no keyboard, nothing to type on the robot. This page makes the card's setup files: on its first boot your Raspberry Pi joins your Wi-Fi, turns on SSH, installs OpenVibe and adds itself to your robots.</p></header>
<section class="dir-sec sd-need" aria-labelledby="sd-need-h"><h2 id="sd-need-h">What you need</h2>
<ul class="sd-list"><li>The robot's Raspberry Pi (3B+, 4, 5 or Zero 2 W)</li><li>A microSD card, 16 GB or more: everything on it is erased</li><li>A computer with a card reader</li><li>Your Wi-Fi name and password (2.4 GHz works on every Pi)</li></ul></section>
<ol class="sd-steps">
<li class="sd-step"><h2>Describe the robot and your Wi-Fi</h2>
${form}
<p class="sd-made" id="sd-made" role="status" hidden></p></li>
<li class="sd-step"><h2>Write Raspberry Pi OS to the card</h2>
<ol class="sd-sub">
<li>Install ${link('https://www.raspberrypi.com/software/', 'Raspberry Pi Imager')} on your computer (version 2.0 or newer) and put the card in.</li>
<li><b>Device</b>: your Pi (e.g. Raspberry Pi 4). <b>Operating system</b>: Raspberry Pi OS (other) → <b>Raspberry Pi OS Lite (64-bit)</b>. <b>Storage</b>: your microSD card.</li>
<li>When Imager offers to customise the OS, <b>skip it</b> (choose No): your two files do that.</li>
<li>Write, and wait until Imager says it is done and verified.</li></ol></li>
<li class="sd-step"><h2>Add your two files to the card</h2>
<div id="sd-files" hidden>
<p class="sd-dl"><a class="dir-btn dir-primary" id="sd-dl-user" href="#">Download user-data</a> <a class="dir-btn dir-primary" id="sd-dl-net" href="#">Download network-config</a></p>
<p class="muted dir-note">Made a mistake? Reload this page and make new files. Files that are never used stop working after 7 days.</p>
</div>
<ol class="sd-sub">
<li>Take the card out of the computer and put it back in. A drive called <b>bootfs</b> opens.</li>
<li>Copy <code>user-data</code> and <code>network-config</code> there, replacing the files with the same names.</li>
<li>The names must be exactly <code>user-data</code> and <code>network-config</code>, with no <code>.txt</code> (on Windows, turn on File name extensions to check).</li>
<li>Eject the card.</li></ol></li>
<li class="sd-step"><h2>Switch the robot on</h2>
<p>Put the card in the robot's Pi and switch it on. The first start takes 3 to 10 minutes: it sets itself up, restarts once, joins your Wi-Fi and installs OpenVibe and the robot's driver.</p>
<p class="sd-status" id="sd-status" data-state="idle" role="status" aria-live="polite"><span class="sd-dot"></span><span data-sd-text>${signedIn ? 'Make your card files first: this shows your robot arriving.' : 'Sign in and make your card files: this shows your robot arriving.'}</span> <a class="dir-btn" data-sd-open hidden href="#">Open the panel</a></p></li>
</ol>
<section class="dir-sec sd-help" aria-labelledby="sd-help-h"><h2 id="sd-help-h">If it does not arrive</h2>
<ul class="sd-list">
<li><b>Check the Wi-Fi name and password.</b> Both are exact (capitals matter). Some older Pis see only 2.4 GHz networks.</li>
<li><b>Log in and look.</b> From a computer on the same Wi-Fi: <code>ssh <span data-sd-user>robot</span>@<span data-sd-host>your-hostname</span>.local</code> with the login you chose, then <code>journalctl -u openvibe-setup</code> shows what it did. With a screen and keyboard on the Pi, log in there.</li>
<li><b>Each set of files adds one robot</b> and works for 7 days. To start again, make new files here.</li>
<li><b>Raspberry Pi OS already running on it?</b> Skip the card: run <code>${esc(installer)}</code> on it and approve its code at ${link('/link', 'openvibe.bot/link')}.</li>
</ul></section>
<script src="/panel/sd-card.js" defer></script>`;
    return framePage({ config, title: 'A robot from a blank microSD card · OpenVibe.Bot', canonicalPath: '/setup/sd-card',
        description: 'Set up a Raspberry Pi robot from a blank microSD card with no screen or keyboard: the card joins your Wi-Fi and adds the robot to openvibe.bot by itself.',
        head: '<link rel="stylesheet" href="/directory.css">', body: `<main id="main" class="dir sd">${body}</main>` });
}

module.exports = { renderSdCard, COUNTRIES };
