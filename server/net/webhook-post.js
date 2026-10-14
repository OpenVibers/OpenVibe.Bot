'use strict';
/**
 * The one place Bot connects to an address a caller chose: a robot's webhook (plan T15; the same poster as
 * OpenVibe.Actor's). Everything else Bot fetches goes to a configured base.
 *
 *   checkWebhookUrl(url)   → URL, or throws WebhookRefused: https only, port 443 or 8443, no credentials, not a name
 *                            that can only mean this machine or a private network, not a non-public IP literal
 *   createWebhookPoster({ userAgent, timeoutMs, lookup }) → post(url, { headers, body }) → { status }
 *
 * The poster checks the URL again at send time and connects through openvibe-shared/egress safeLookup, which fails
 * unless every address the name resolves to is public, so a DNS answer cannot change between the check and the
 * connect. A redirect is never followed (a 3xx is the receiver's answer like any other), and at most a few KiB of the
 * answer are read and discarded: nothing a receiver says is stored.
 */
const https = require('https');
const net = require('net');
const egress = require('openvibe-shared/egress');

const PORTS = new Set(['', '443', '8443']);
const MAX_RESPONSE_BYTES = 4096;

class WebhookRefused extends Error {
    constructor(detail) { super(detail); this.code = 'bot.webhook.refused'; }
}

function checkWebhookUrl(input) {
    let u;
    try { u = new URL(String(input)); } catch { throw new WebhookRefused('not a URL'); }
    if (u.protocol !== 'https:') throw new WebhookRefused('a webhook URL is https');
    if (u.username || u.password) throw new WebhookRefused('credentials in the URL are not allowed');
    if (!PORTS.has(u.port)) throw new WebhookRefused('a webhook URL uses port 443 or 8443');
    const host = egress.normalizeHost(u.hostname);
    if (net.isIP(host) ? !egress.isPublicAddress(host) : egress.isInternalName(host)) throw new WebhookRefused(`${host} is not a public address`);
    return u;
}

function createWebhookPoster({ userAgent = 'OpenVibe.Bot', timeoutMs = 10_000, lookup = egress.safeLookup } = {}) {
    return async function post(url, { headers = {}, body = '' } = {}) {
        const u = checkWebhookUrl(url);
        const payload = Buffer.from(String(body));
        return await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
            const req = https.request(u, {
                method: 'POST', lookup, timeout: timeoutMs,
                headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'User-Agent': userAgent, ...headers },
            }, (res) => {
                let seen = 0;
                res.on('data', (chunk) => { seen += chunk.length; if (seen > MAX_RESPONSE_BYTES) res.destroy(); });
                const done = () => finish(resolve, { status: res.statusCode });
                res.on('end', done);
                res.on('close', done);
                res.on('error', done);
            });
            req.on('timeout', () => req.destroy(Object.assign(new Error(`no answer within ${timeoutMs} ms`), { code: 'ETIMEDOUT' })));
            req.on('error', (err) => finish(reject, err));
            req.end(payload);
        });
    };
}

module.exports = { checkWebhookUrl, createWebhookPoster, WebhookRefused };
