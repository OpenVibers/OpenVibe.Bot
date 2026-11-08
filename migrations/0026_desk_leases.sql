-- phase: expand
-- Run sessions (contracts 0.223.0, the Desks plan's D6). A machine's owner may offer its desks to other people
-- (shared_desks, off until they turn it on on openvibe.bot/machines; only where its OpenVibe Node runs every desk in its
-- own sandbox, desk_isolation sandbox, Node v0.32.0). OpenVibe.Run leases one named desk per session there, or on the
-- person's own machine (bot.desk-lease@1): only that session's commands reach the desk, and the lease ends with it.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS shared_desks boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS desk_leases (
    device_id      text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    desk           text NOT NULL CHECK (desk ~ '^desk-[a-z0-9][a-z0-9-]{0,23}$'),
    session_id     text NOT NULL,                       -- ses_<ULID>, the OpenVibe.Run session
    owner_subject  text NOT NULL,                       -- user:usr_…, the only one whose commands reach the desk
    kind           text NOT NULL DEFAULT 'browser' CHECK (kind IN ('browser')),
    width          integer NOT NULL,
    height         integer NOT NULL,
    shared         boolean NOT NULL,                    -- a desk host serving other people (true) or the owner's machine
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, desk)
);
CREATE UNIQUE INDEX IF NOT EXISTS desk_leases_session_idx ON desk_leases (session_id);
