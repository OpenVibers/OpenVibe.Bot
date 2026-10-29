'use strict';
// The agent manifest of OpenVibe.Bot: what the site is, where its API and docs are, and how it is
// reached. openvibe-shared/agent-layer turns this into /.well-known/agent.json.
module.exports = {
    id: 'bot', name: 'OpenVibe.Bot',
    purpose: 'Devices, pairing and control for robots: add a robot, pair it with one pasted command, then drive it from any browser through a panel laid out from its profile.',
    home: 'https://openvibe.bot', api: '/api/v1',
    docs: 'https://openvibe.bot/docs',
    policy: {
        auth: ['bearer', 'Network OIDC'],
        rateLimit: 'The API is rate limited per caller and per robot; the owner\'s plan sets the numbers.',
    },
};
