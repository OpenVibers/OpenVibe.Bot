'use strict';
/**
 * The catalogue of machine roles (plan L34, step M4: a product declares a machine role — a name, what it installs
 * and what the hub shows — and the Node turns it on at its next check-in).
 *
 * The catalogue lives in the Contracts release: each product's service manifest carries its own roles
 * (`machineRoles`, openvibe-contracts 0.257.0), and the hub's catalogue is the union of them. Until a service
 * pins that release the copy below is the catalogue; when the pin moves, the manifests are, and this file's list
 * goes with it. Bot only ever refuses a role outside the catalogue: a role is a promise the Node has to keep, so
 * an unknown one is refused rather than stored.
 *
 *   catalogue()   the roles, as [{ id, name, installs, shows }]
 *   isKnown(id)   whether the catalogue has that role
 *   normalise(list) the roles of a request, checked: the same ids, no duplicates, no unknown role
 */
const contracts = require('openvibe-contracts');

/** The catalogue while the pinned contracts are older than 0.257.0. Keep it in step with the manifests. */
const LOCAL = [
    { id: 'codes.worker', name: 'Codes worker', installs: 'the Codes job runner (the coding agent and the job sandbox)', shows: 'Runs your coding jobs, such as a task you start on openvibe.codes.' },
    { id: 'desks.host', name: 'Desk host', installs: 'the desk sandbox (a private browser desk for every session)', shows: "Hosts desks for agents, yours and other people's." },
    { id: 'ai.host', name: 'AI host', installs: "the local model server (Ollama, LM Studio) as OpenVibe Node's ai plugin", shows: 'Serves your own AI models, on your own machine.' },
    { id: 'bot.robot', name: 'Robot', installs: 'the robot drivers the profile asks for', shows: 'Drives a robot, and takes its commands.' },
];

/** The roles the products declare, or the local copy while the pinned contracts are older than 0.257.0. */
function catalogue() {
    const declared = (contracts.services.manifests || []).flatMap((m) => Array.isArray(m.machineRoles) ? m.machineRoles : []);
    return declared.length ? declared : LOCAL;
}

const known = () => new Set(catalogue().map((r) => r.id));

/** Whether the catalogue has that role. */
function isKnown(id) { return known().has(String(id || '')); }

/**
 * The roles of a request, checked: a list of ids, each in the catalogue, no duplicates. Returns the ids in the
 * catalogue's order (so the same set always reads the same way). Throws with `unknown` when a role is not in the
 * catalogue; the caller answers 422.
 */
function normalise(list) {
    if (!Array.isArray(list)) { const e = new Error('roles must be a list'); e.unknown = false; throw e; }
    const want = known();
    const out = [];
    for (const raw of list) {
        const id = String(raw || '');
        if (!want.has(id)) { const e = new Error(`unknown role ${id}`); e.unknown = true; e.role = id; throw e; }
        if (!out.includes(id)) out.push(id);
    }
    return catalogue().map((r) => r.id).filter((id) => out.includes(id));
}

module.exports = { LOCAL, catalogue, isKnown, normalise };
