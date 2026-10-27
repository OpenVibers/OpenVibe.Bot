'use strict';
/**
 * A machine's own models (AI on your own machines, contracts 0.219.0 kind ai), from the capabilities its OpenVibe Node
 * declares. The Node reports each plugin's describe under the plugin's name, so the ai plugin (Node v0.27.0) arrives as
 * capabilities.ai = { ai: { models, ready, max_tokens } }; a computer plugin that offered ai itself would put it in
 * capabilities.computer.ai. → { models, ready, max_tokens } or null
 */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function aiOf(capabilities) {
    if (!isObj(capabilities)) return null;
    if (isObj(capabilities.ai) && isObj(capabilities.ai.ai)) return capabilities.ai.ai;
    if (isObj(capabilities.computer) && isObj(capabilities.computer.ai)) return capabilities.computer.ai;
    return null;
}

/** The computer kinds a machine offers: its computer plugin's capabilities, with its models from the ai plugin. */
function computerCaps(capabilities) {
    const c = isObj(capabilities) && isObj(capabilities.computer) ? capabilities.computer : null;
    const ai = aiOf(capabilities);
    if (!c) return ai ? { ai } : null;
    return ai && !isObj(c.ai) ? { ...c, ai } : c;
}

module.exports = { aiOf, computerCaps };
