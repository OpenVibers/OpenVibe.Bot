'use strict';

/**
 * Bot → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 *   bot.robot.online      a device authenticated and is serving its robot
 *   bot.robot.offline     no heartbeat within 2 missed intervals + the grace window
 *   bot.estop.set         the e-stop latched (by the owner, an operator or the device)
 *   bot.estop.cleared     the owner cleared the latched e-stop
 *   bot.command.refused   the gate refused a command (role, allowlist, limits, policy, e-stop, cooldown)
 *
 * emitIn(t, …) runs inside the transaction that makes the change, so an event exists if and only if its
 * change committed. The relay publishes with Bot's service token (events.event.publish) only when
 * EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set; otherwise rows wait in bot_event_outbox. Payloads carry
 * ids, kinds and results only — never a credential, a pairing code or a publish key.
 */
const { createServiceOutbox } = require('openvibe-sdk/events');

const TABLE = 'bot_event_outbox';   // migrations/0001_bot.sql
const ACTOR = { type: 'service', id: 'bot' };
const ENVELOPE = { actor: ACTOR, visibility: 'internal', priority: 'important' };

function createBotOutbox({ db, config, fetchImpl, now, log = console }) {
    return createServiceOutbox({
        db,
        source: 'bot',
        table: TABLE,
        eventsUrl: config.events.url,
        networkInternalUrl: config.network.internalUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.intervalMs,
        log,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        ...(now ? { now } : {}),
    });
}

module.exports = { createBotOutbox, TABLE, ACTOR, ENVELOPE };
