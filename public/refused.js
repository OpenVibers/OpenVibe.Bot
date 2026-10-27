/* OpenVibe.Bot — the framed "not shown here yet" page (server/web/render.js renderEmbedRefused): it tells the page around
   the frame, only when that page is one of the allowed embedders, so a Live channel can hide the box from its viewers and
   point its owner to "Put the buttons under my OpenVibe.Live stream". It says nothing but the robot id the page framed. */
(() => {
    const el = document.querySelector('[data-embed-refused]');
    if (!el || window.parent === window) return;
    const robotId = el.getAttribute('data-embed-refused');
    for (const origin of String(el.getAttribute('data-parent-origins') || '').split(' ').filter(Boolean)) {
        try { window.parent.postMessage({ type: 'ov-bot-embed-refused', robot_id: robotId }, origin); } catch { /* not that origin */ }
    }
})();
