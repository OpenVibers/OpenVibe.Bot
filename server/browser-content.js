'use strict';

const { randomBytes } = require('crypto');
const MAX_PAGE = 48 * 1024;
const MAX_TEXT = 20 * 1024;
const FENCED = /^<<<ov-text nonce:([0-9a-f]{32}) origin:[^\n]*>>>\n([\s\S]*)\n<<<ov-text-end nonce:\1>>>$/;

function cap(value, bytes) {
    const text = typeof value === 'string' ? value : '';
    const raw = Buffer.from(text);
    if (raw.length <= bytes) return [text, false];
    const cut = raw.subarray(0, bytes).toString('utf8').replace(/\uFFFD$/, '');
    return [`${cut}\n…[truncated ${raw.length - bytes} bytes]`, true];
}

function plain(value) {
    const m = typeof value === 'string' ? FENCED.exec(value) : null;
    return m ? m[2] : value;
}

function originOf(url) {
    try {
        const u = new URL(url);
        return ['http:', 'https:'].includes(u.protocol) && /^[a-z0-9.:[\]-]+$/i.test(u.hostname) ? u.origin : 'unknown';
    } catch { return 'unknown'; }
}

function boundPage(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.text !== 'string') return data;
    const nonce = randomBytes(16).toString('hex');
    const origin = originOf(data.url);
    const fence = (value) => `<<<ov-text nonce:${nonce} origin:${origin}>>>\n${value}\n<<<ov-text-end nonce:${nonce}>>>`;
    const [body, bodyCut] = cap(plain(data.text), MAX_TEXT);
    const [title, titleCut] = cap(data.title, 512);
    const [url, urlCut] = cap(data.url, 2048);
    const out = { url, title, text: fence(body), fence: nonce, origin, links: [], elements: [],
        truncated: Boolean(data.truncated || bodyCut || titleCut || urlCut) };
    for (const item of Array.isArray(data.links) ? data.links : []) {
        if (!item || typeof item !== 'object') { out.truncated = true; continue; }
        const [label, labelCut] = cap(item.text, 160);
        const [href, hrefCut] = cap(item.href, 2048);
        out.links.push({ text: label, href });
        out.truncated ||= labelCut || hrefCut;
        if (Buffer.byteLength(JSON.stringify(out)) > MAX_PAGE) { out.links.pop(); out.truncated = true; break; }
    }
    for (const item of Array.isArray(data.elements) ? data.elements : []) {
        const [line, lineCut] = cap(item, 256);
        out.elements.push(line);
        out.truncated ||= lineCut;
        if (Buffer.byteLength(JSON.stringify(out)) > MAX_PAGE) { out.elements.pop(); out.truncated = true; break; }
    }
    if (data.receipt && typeof data.receipt === 'object' && !Array.isArray(data.receipt)) {
        const appeared = Array.isArray(data.receipt.appeared) ? data.receipt.appeared : [];
        const gone = Array.isArray(data.receipt.gone) ? data.receipt.gone : [];
        out.receipt = { url_changed: data.receipt.url_changed === true,
            appeared: appeared.slice(0, 8).map((line) => fence(cap(plain(line), 160)[0])),
            gone: gone.slice(0, 8).map((line) => cap(line, 160)[0]) };
        out.truncated ||= appeared.length > 8 || gone.length > 8;
    }
    // Body text is the last adjustable field; preserve both markers if a verbose old Link exceeded the cap.
    while (Buffer.byteLength(JSON.stringify(out)) > MAX_PAGE && out.elements.length) { out.elements.pop(); out.truncated = true; }
    while (Buffer.byteLength(JSON.stringify(out)) > MAX_PAGE && out.links.length) { out.links.pop(); out.truncated = true; }
    if (Buffer.byteLength(JSON.stringify(out)) > MAX_PAGE) {
        const excess = Buffer.byteLength(JSON.stringify(out)) - MAX_PAGE;
        out.text = fence(cap(body, Math.max(0, Buffer.byteLength(body) - excess - 256))[0]);
        out.truncated = true;
    }
    return out;
}

module.exports = { boundPage, MAX_PAGE };
