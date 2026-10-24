/* openvibe.bot /setup/sd-card: a Raspberry Pi's first-boot files for a fresh microSD card, made in this browser.
 *
 * Raspberry Pi OS (Trixie images since November 2025) sets itself up on first boot from cloud-init files on the card's
 * boot partition, the drive any computer sees: `user-data` (the login, SSH, the hostname, and here one command that adds
 * the robot to openvibe.bot) and `network-config` (Wi-Fi). Raspberry Pi Imager writes them too, but appending to its
 * user-data would break it (a second runcmd: replaces the first), so this page writes both whole files instead.
 *
 * The Wi-Fi password and the login password never leave this page: the password is hashed here (SHA-512 crypt, what
 * Imager writes too) and both go only into the files you download. openvibe.bot is sent the robot's name, model, who
 * may drive, Live and the hostname, and answers a setup key for the card (server/setup-keys.js).
 *
 * In Node (tests) this file exports the pure parts: sha512Crypt, yamlQuote, userData, networkConfig.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => api.init(document));
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const subtle = () => (typeof crypto !== 'undefined' && crypto.subtle) || require('crypto').webcrypto.subtle;
    const enc = (s) => new TextEncoder().encode(s);
    const concat = (parts) => {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) { out.set(p, at); at += p.length; }
        return out;
    };
    const sha512 = async (bytes) => new Uint8Array(await subtle().digest('SHA-512', bytes));
    /** `bytes` repeated to `len` bytes. */
    const stretch = (bytes, len) => { const out = new Uint8Array(len); for (let i = 0; i < len; i++) out[i] = bytes[i % bytes.length]; return out; };

    const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    // SHA-512 crypt's output order (Drepper's specification): 21 groups of three bytes, then the last byte alone.
    const ORDER = [[0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48], [28, 49, 7], [50, 8, 29], [9, 30, 51],
        [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13], [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41]];

    /**
     * crypt(3)'s SHA-512 scheme ($6$, 5000 rounds): what /etc/shadow and cloud-init's `passwd:` take. The same as
     * `openssl passwd -6 -salt <salt> <password>` (test/sd-card.test.js checks it against that).
     */
    async function sha512Crypt(password, salt) {
        const P = enc(password);
        const S = enc(String(salt).slice(0, 16));
        const B = await sha512(concat([P, S, P]));
        const a = [P, S, stretch(B, P.length)];
        for (let n = P.length; n > 0; n >>= 1) a.push(n & 1 ? B : P);
        const A = await sha512(concat(a));
        const DP = await sha512(concat(Array.from({ length: P.length }, () => P)));
        const Pp = stretch(DP, P.length);
        const DS = await sha512(concat(Array.from({ length: 16 + A[0] }, () => S)));
        const Sp = stretch(DS, S.length);
        let C = A;
        for (let i = 0; i < 5000; i++) {
            const parts = [i & 1 ? Pp : C];
            if (i % 3) parts.push(Sp);
            if (i % 7) parts.push(Pp);
            parts.push(i & 1 ? C : Pp);
            C = await sha512(concat(parts));
        }
        let out = '';
        const b64 = (b2, b1, b0, n) => { let w = (b2 << 16) | (b1 << 8) | b0; for (let i = 0; i < n; i++) { out += ITOA64[w & 0x3f]; w >>= 6; } };
        for (const [x, y, z] of ORDER) b64(C[x], C[y], C[z], 4);
        b64(0, 0, C[63], 2);
        return `$6$${String(salt).slice(0, 16)}$${out}`;
    }

    /** A salt of 16 crypt characters from the browser's random source. */
    function newSalt() {
        const bytes = new Uint8Array(16);
        (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : require('crypto').webcrypto).getRandomValues(bytes);
        return Array.from(bytes, (b) => ITOA64[b & 0x3f]).join('');
    }

    /** A YAML double-quoted scalar: backslash and quote escaped, control characters as \xHH (as Imager does). */
    function yamlQuote(value) {
        return `"${String(value).replace(/\r?\n$/, '').replace(/[\\"\u0000-\u001f\u007f]/g, (c) => (c === '\\' ? '\\\\' : c === '"' ? '\\"'
            : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`))}"`;
    }

    /**
     * user-data. Mirrors what Raspberry Pi Imager 2 writes (its customization_generator.cpp): the `user:` block, avahi
     * so <hostname>.local answers, SSH on, I2C and SPI for the robot's boards. Then the one thing Imager cannot do: a
     * first-boot service that waits for the network and runs openvibe.bot's installer with the card's setup key, so the
     * robot adds itself with nothing typed on it. Its output: `journalctl -u openvibe-setup`.
     */
    function userData({ hostname, username, passwordHash, sshKeys = [], timezone = '', setupKey, server = 'https://openvibe.bot', robotName = '' }) {
        if (!/^osk_[A-Za-z0-9_-]{43}$/.test(setupKey || '')) throw new Error('no setup key');
        if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(server)) throw new Error('bad server');
        const keys = sshKeys.map((k) => k.trim()).filter(Boolean);
        const script = [
            '#!/bin/sh',
            `# Made on ${server}/setup/sd-card: adds this robot to openvibe.bot once, on its first boot, with the card's setup key.`,
            '# Its output: journalctl -u openvibe-setup',
            'key="$(cat /etc/openvibe/setup-key)"',
            'for i in $(seq 1 90); do',
            `  curl -fsS -o /dev/null --max-time 10 ${server}/install && break`,
            '  echo "waiting for the network ($i of 90)"; sleep 10',
            'done',
            'for try in 1 2 3; do',
            `  if curl -fsSL ${server}/install | sh -s -- --setup "$key"; then rm -f /etc/openvibe/setup-key; exit 0; fi`,
            '  echo "the installer stopped (try $try of 3): trying again in a minute"; sleep 60',
            'done',
            'exit 1',
        ];
        const lines = [
            '#cloud-config',
            `# Made on ${server}/setup/sd-card${robotName ? ` for ${String(robotName).replace(/[\r\n]/g, ' ')}` : ''}. Copy this file and network-config onto`,
            '# the card\'s boot partition (bootfs), replacing the ones there. On first boot the Pi joins your Wi-Fi, turns on SSH',
            '# and adds itself to openvibe.bot.',
            `hostname: ${yamlQuote(hostname)}`,
            'manage_etc_hosts: true',
            'packages:',
            '- avahi-daemon',
            '',
            'apt:',
            '  preserve_sources_list: true',
            '  conf: |',
            '    Acquire {',
            '      Check-Date "false";',
            '    };',
            '',
            ...(timezone ? [`timezone: ${yamlQuote(timezone)}`] : []),
            'user:',
            `  name: ${yamlQuote(username)}`,
            '  shell: /bin/bash',
            '  lock_passwd: false',
            `  passwd: ${yamlQuote(passwordHash)}`,
            ...(keys.length ? ['  ssh_authorized_keys:', ...keys.map((k) => `    - ${yamlQuote(k)}`)] : []),
            '  sudo: ALL=(ALL) NOPASSWD:ALL',
            '',
            'ssh_pwauth: true',
            '',
            'rpi:',
            '  interfaces:',
            '    i2c: true',
            '    spi: true',
            '',
            'write_files:',
            '- path: /etc/openvibe/setup-key',
            '  permissions: "0600"',
            `  content: ${yamlQuote(setupKey)}`,
            '- path: /usr/local/sbin/openvibe-firstboot',
            '  permissions: "0755"',
            '  content: |',
            ...script.map((l) => `    ${l}`),
            '',
            'runcmd:',
            '  - [ systemctl, enable, --now, ssh ]',
            '  - [ systemd-run, --unit=openvibe-setup, "--description=Add this robot to openvibe.bot", /usr/local/sbin/openvibe-firstboot ]',
            '',
        ];
        return lines.join('\n');
    }

    /** network-config: Wi-Fi for wlan0 (and Ethernet if a cable is in), in the form Imager writes. */
    function networkConfig({ ssid, password = '', country, hidden = false }) {
        const lines = [
            '# Made on openvibe.bot/setup/sd-card: the Wi-Fi this Raspberry Pi joins on first boot.',
            'network:',
            '  version: 2',
            '  ethernets:',
            '    eth0:',
            '      dhcp4: true',
            '      dhcp6: true',
            '      optional: true',
            '  wifis:',
            '    wlan0:',
            '      dhcp4: true',
            `      regulatory-domain: ${yamlQuote(String(country).toUpperCase())}`,
            '      access-points:',
            `        ${yamlQuote(ssid)}:`,
            ...(hidden ? ['          hidden: true'] : []),
            ...(password ? [`          password: ${yamlQuote(password)}`] : ['          auth:', '            key-management: none']),
            '      optional: true',
            '',
        ];
        return lines.join('\n');
    }

    // ── The page ─────────────────────────────────────────────────────────────────────────────────────────────
    function init(doc) {
        const form = doc.getElementById('sd-form');
        if (!form) return;
        const $ = (sel) => doc.querySelector(sel);
        const out = $('#sd-files');
        const err = $('#sd-error');
        const btn = form.querySelector('button[type=submit]');
        const tz = form.querySelector('input[name=timezone]');
        try { if (tz && !tz.value) tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* no zone: the Pi keeps UTC */ }
        const country = form.querySelector('select[name=wifi_country]');
        if (country && !country.dataset.chosen) {
            const guess = ((navigator.language || '').split('-')[1] || '').toUpperCase();
            if (guess && country.querySelector(`option[value="${guess}"]`)) country.value = guess;
        }
        // The hostname follows the name until it is typed in.
        const name = form.querySelector('input[name=name]');
        const host = form.querySelector('input[name=hostname]');
        const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'robot';
        let hostTyped = !!(host && host.value);
        if (host) host.addEventListener('input', () => { hostTyped = true; });
        if (name && host) name.addEventListener('input', () => { if (!hostTyped) host.value = slug(name.value); });
        if (name && host && !host.value) host.value = slug(name.value || 'robot');

        const say = (msg) => { err.textContent = msg; err.hidden = !msg; if (msg) err.focus(); };
        const download = (a, filename, text) => {
            const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
            a.href = url;
            a.download = filename;
        };

        form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            say('');
            const f = new FormData(form);
            const v = (k) => String(f.get(k) || '');
            if (v('password').length < 8) return say('Choose a login password of at least 8 characters (you use it to SSH in).');
            if (v('password') !== v('password2')) return say('The two login passwords are not the same.');
            if (v('wifi_password') && (v('wifi_password').length < 8 || v('wifi_password').length > 63)) return say('A Wi-Fi password is 8 to 63 characters. Leave it empty only for an open network.');
            if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v('hostname'))) return say('The hostname is lowercase letters, digits and dashes.');
            if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(v('username')) || v('username') === 'root') return say('The username is lowercase letters, digits, - and _ (not root).');
            btn.disabled = true;
            const label = btn.textContent;
            btn.textContent = 'Making your card files…';
            try {
                const r = await fetch('/setup/sd-card/keys', {
                    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    // Only these leave the page: never the Wi-Fi or the login password.
                    body: JSON.stringify({ name: v('name'), profile_id: v('profile_id'), access_policy: v('access_policy'), live: f.get('live') === 'on', hostname: v('hostname') }),
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(j.detail || j.error || `openvibe.bot answered ${r.status}`);
                const passwordHash = await sha512Crypt(v('password'), newSalt());
                const files = {
                    'user-data': userData({ hostname: v('hostname'), username: v('username'), passwordHash, sshKeys: v('ssh_keys').split(/\r?\n/), timezone: v('timezone'),
                        setupKey: j.key, server: form.dataset.server || location.origin, robotName: v('name') }),
                    'network-config': networkConfig({ ssid: v('wifi_ssid'), password: v('wifi_password'), country: v('wifi_country'), hidden: f.get('wifi_hidden') === 'on' }),
                };
                download($('#sd-dl-user'), 'user-data', files['user-data']);
                download($('#sd-dl-net'), 'network-config', files['network-config']);
                for (const el of doc.querySelectorAll('[data-sd-host]')) el.textContent = v('hostname');
                for (const el of doc.querySelectorAll('[data-sd-user]')) el.textContent = v('username');
                const made = $('#sd-made');
                if (made) {
                    made.textContent = `Card files made for ${v('name')}: it joins the Wi-Fi network "${v('wifi_ssid')}", and you can log in as ${v('username')}@${v('hostname')}.local.`;
                    made.hidden = false;
                }
                out.hidden = false;
                form.hidden = true;
                out.scrollIntoView({ behavior: 'smooth', block: 'start' });
                watch(j.id);
            } catch (e) {
                say(`Could not make the card files: ${e.message}`);
            } finally {
                btn.disabled = false;
                btn.textContent = label;
            }
        });

        // After the files: follow the card. waiting → installing (the Pi asked with its key) → paired (online).
        function watch(id) {
            const status = $('#sd-status');
            const text = status.querySelector('[data-sd-text]');
            const open = status.querySelector('[data-sd-open]');
            const words = {
                waiting: 'Waiting for your robot to start. After you power it on, this takes 3 to 10 minutes.',
                installing: 'Your robot asked to join with this card. It is installing OpenVibe and its driver…',
                paired: 'Your robot is online.',
                expired: 'These card files are more than 7 days old. Make new ones.',
                revoked: 'These card files were revoked. Make new ones.',
            };
            const tick = async () => {
                let s = null;
                try { const r = await fetch(`/setup/sd-card/keys/${encodeURIComponent(id)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } }); if (r.ok) s = await r.json(); } catch { /* try again */ }
                if (s) {
                    status.dataset.state = s.state;
                    text.textContent = words[s.state] || s.state;
                    if (s.robot_id) { open.href = s.state === 'paired' ? `/panel/${encodeURIComponent(s.robot_id)}` : `/r/${encodeURIComponent(s.robot_id)}`; open.hidden = false; open.textContent = s.state === 'paired' ? 'Open the panel' : 'See the robot'; }
                    if (s.state === 'paired' || s.state === 'expired' || s.state === 'revoked') return;
                }
                setTimeout(tick, 5000);
            };
            tick();
        }
    }

    return { sha512Crypt, newSalt, yamlQuote, userData, networkConfig, init };
}));
