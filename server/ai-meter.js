'use strict';
/**
 * Bot's meter for AI that runs on people's own machines (ai-metrics.md, platform L40/L41). An `ai` command's answer
 * is one call that did not go through OpenVibe.AI: OpenVibe Link's ai plugin relayed it to the machine's own Ollama,
 * LM Studio or llama.cpp server. Bot sends it to AI's POST /api/v1/usage/calls as ai.call-report@1 (through
 * openvibe-sdk/ai-meter), which prices it and publishes one ai.call.recorded@1.
 *
 *   createAiMeter({ config, fetchImpl, log }) → { enabled, startCall, record, flush, close, stats }
 *
 * Bot mints its own Network service token (client `bot`, audience openvibe.ai, capability ai.usage.report) from its
 * OAuth client, like the OpenRestream and Billing clients. OV_AI_INTERNAL_URL unset, or no client secret to mint a
 * token with, keeps metering off: startCall returns null, record does nothing and the command path is unchanged.
 */
const { serviceAuth } = require('openvibe-contracts');
const sdkMeter = require('openvibe-sdk/ai-meter');

const AI_AUDIENCE = 'openvibe.ai';
const AI_SCOPE = 'ai.usage.report';

function createAiMeter({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const aiUrl = config && config.ai && config.ai.internalUrl;
    const { clientId, clientSecret } = (config && config.oauth) || {};
    const internalUrl = config && config.network && config.network.internalUrl;
    const tokenClient = aiUrl && clientSecret && internalUrl
        ? serviceAuth.createTokenClient({ tokenUrl: `${internalUrl}/oauth/token`, clientId, clientSecret, audience: AI_AUDIENCE, scope: AI_SCOPE, fetchImpl })
        : null;
    if (!aiUrl || !tokenClient) {
        return {
            enabled: false,
            startCall: () => null,
            record: () => false,
            flush: async () => {},
            close: async () => {},
            stats: () => ({ sent: 0, dropped: 0, rejected: 0, retried: 0, queued: 0 }),
        };
    }
    const client = sdkMeter.createMeterClient({ aiUrl, tokenClient, fetch: fetchImpl, log });
    return {
        enabled: true,
        startCall: sdkMeter.startCall,
        record: client.record,
        flush: client.flush,
        close: client.close,
        stats: client.stats,
    };
}

module.exports = { createAiMeter, AI_AUDIENCE, AI_SCOPE };
