'use strict';

/**
 * The Drive popup (/panel/:id/drive, server/web/render.js renderDrivePage). It is first-party, so it has the
 * openvibe.bot session that a panel framed on another site cannot see: it mints a one-time control ticket
 * (POST /panel/:id/ticket) and posts it to the panel that opened it, on this origin only, then closes. Signing in on
 * the way (OpenVibe.Network) cuts the link to the opener, so then it says to press Drive again.
 */
(() => {
    const pageEl = document.querySelector('[data-drive-page]');
    const statusEl = document.querySelector('[data-drive-status]');
    const say = (text) => { if (statusEl) statusEl.textContent = text; };
    const robotId = pageEl && pageEl.dataset.robotId;
    if (!robotId) return;
    if (!window.opener) {
        say('You are signed in. Go back to the stream and press Drive again.');
        return;
    }
    fetch(`/panel/${encodeURIComponent(robotId)}/ticket`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then((r) => r.json().catch(() => ({})).then((body) => ({ ok: r.ok, body })))
        .then(({ ok, body }) => {
            if (!ok || !body.ticket) { say(body.detail || 'This robot cannot be driven from here.'); return; }
            window.opener.postMessage({ type: 'ov-bot-ticket', robot_id: robotId, ticket: body.ticket }, location.origin);
            say('The panel has the controls. This window closes now.');
            setTimeout(() => window.close(), 400);
        })
        .catch(() => say('openvibe.bot did not answer. Close this window and press Drive again.'));
})();
