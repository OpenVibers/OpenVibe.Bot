'use strict';
/**
 * Vibe by voice on a person's own machine (consumer plan §8; openvibe-contracts 0.214.0 bot.device-message@1
 * voice_ask / voice_answer, chat.vibe.ask). The owner turns voice on for a machine and chooses its call word
 * (migrations/0024_machine_voice.sql); the machine (OpenVibe Node's voice plugin) listens for the word, transcribes what
 * follows on the machine itself, and sends voice_ask. realtime.js answers `working` at once and hands the question here:
 * Bot asks Vibe as the owner through OpenVibe.Chat (POST /internal/chat/vibe/ask with its own service token, audience
 * openvibe.chat, chat.vibe.ask), which keeps it in the owner's "Voice on <machine>" chat, and the answer goes back to the
 * machine to speak.
 *
 *   createVoice({ config, fetchImpl, now }) → { enabled, callWordOf(device), validCallWord(v), allow(deviceId),
 *                                               ask({ device, owner, id, text, lang }) → { state, text, url? } }
 *
 * At most voice.perHour questions a machine an hour (in this process). Off (refused with why) without Bot's Network
 * client or Chat's internal URL.
 */
const { serviceAuth } = require('openvibe-contracts');

const DEFAULT_CALL_WORD = 'hey vibe';
const ASK_TIMEOUT_MS = 60_000;
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** A call word the owner may choose (as Live's stream call word): 1–4 words, 3–40 characters, one word of 3 letters. */
function validCallWord(v) {
    const w = norm(v);
    if (w.length < 3 || w.length > 40) return null;
    const words = w.split(' ');
    if (words.length > 4 || !words.some((x) => x.replace(/'/g, '').length >= 3)) return null;
    return w;
}

function createVoice({ config, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    const chatUrl = (config.chat && config.chat.internalUrl) || '';
    const { clientId, clientSecret } = config.oauth || {};
    const internalUrl = (config.network || {}).internalUrl;
    const tokens = chatUrl && clientSecret && internalUrl
        ? serviceAuth.createTokenClient({ tokenUrl: `${internalUrl}/oauth/token`, clientId, clientSecret, audience: 'openvibe.chat', scope: 'chat.vibe.ask', fetchImpl })
        : null;
    const perHour = (config.voice && config.voice.perHour) || 30;
    const recent = new Map();   // device id → the times of its last questions (this process)

    /** Room for one more question from this machine this hour (and counts it). */
    function allow(deviceId) {
        const t = now();
        const list = (recent.get(deviceId) || []).filter((x) => t - x < 3_600_000);
        if (list.length >= perHour) { recent.set(deviceId, list); return false; }
        list.push(t);
        if (recent.size > 5000) recent.clear();
        recent.set(deviceId, list);
        return true;
    }

    async function ask({ device, owner, id, text, lang }) {
        if (!tokens) return { state: 'refused', text: 'Vibe cannot be reached from here right now.' };
        let res;
        try {
            const auth = await tokens.authHeaders();
            res = await fetchImpl(`${chatUrl}/internal/chat/vibe/ask`, {
                method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ subject: owner, text, source: { kind: 'voice', id: device.id, name: String(device.name || '').slice(0, 80) || undefined },
                    ...(lang ? { lang } : {}), idempotency_key: `${device.id}:${id}`.slice(0, 128) }),
                signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
            });
        } catch (e) {
            return { state: 'refused', text: e && e.name === 'TimeoutError' ? 'Vibe took too long to answer. Ask again in a minute.' : 'Vibe cannot be reached right now. Ask again in a minute.' };
        }
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || !['answered', 'refused'].includes(body.state)) return { state: 'refused', text: 'Vibe could not answer just now. Ask again in a minute.' };
        return { state: body.state, text: String(body.text || '').slice(0, 2000), ...(typeof body.url === 'string' && body.url.startsWith('https://') ? { url: body.url } : {}) };
    }

    return {
        enabled: !!tokens, allow, ask, validCallWord,
        callWordOf: (device) => (device && device.call_word) || DEFAULT_CALL_WORD,
    };
}

module.exports = { createVoice, validCallWord, DEFAULT_CALL_WORD };
