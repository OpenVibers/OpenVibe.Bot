'use strict';

/**
 * A QR code as inline SVG markup (no script, no image request, so the strict CSP holds): one path of dark modules
 * on a light quiet zone, scaling with the box it is put in. qrcode-generator (MIT) does the encoding.
 *
 *   qrSvg(text, { label }) → '<svg …>'   error correction M; `label` is the image's accessible name
 */
const qrcode = require('qrcode-generator');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

function qrSvg(text, { label = 'QR code' } = {}) {
    const qr = qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    let d = '';
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
    const size = n + quiet * 2;
    return `<svg class="qr" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(label)}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">`
        + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

module.exports = { qrSvg };
