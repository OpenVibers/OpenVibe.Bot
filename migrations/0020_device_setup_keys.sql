-- phase: expand
-- A microSD card made on /setup/sd-card carries a setup key (owner 2026-10-24: a fresh card should not need a screen,
-- a keyboard or a command). On first boot the installer starts a claim with it (`install.sh --setup <key>`), and the
-- claim is approved at once for the key's owner with the choices made with the card files (server/setup-keys.js). The
-- key lasts until its robot has paired, or 7 days; a retry before that pairs the same robot again. Only its hash is kept.
CREATE TABLE IF NOT EXISTS device_setup_keys (
    id             text PRIMARY KEY,                     -- osk_…
    owner_subject  text NOT NULL,
    secret_hash    text NOT NULL UNIQUE,                 -- sha256 of the key written on the card
    name           text NOT NULL,                        -- the robot's name
    profile_id     text NOT NULL,                        -- its model
    access_policy  text NOT NULL DEFAULT 'private',
    want_live      boolean NOT NULL DEFAULT false,       -- its camera on the owner's OpenVibe.Live channel once paired
    hostname       text,                                 -- the hostname written on the card (what the person will ssh to)
    robot_id       text,                                 -- the robot the first claim made
    claim_id       text,                                 -- the last claim the key started
    created_at     timestamptz NOT NULL,
    expires_at     timestamptz NOT NULL,
    claimed_at     timestamptz,                          -- the device first asked with it
    paired_at      timestamptz,                          -- its robot paired: the key is spent
    revoked_at     timestamptz
);
CREATE INDEX IF NOT EXISTS device_setup_keys_owner_idx ON device_setup_keys (owner_subject, created_at);
CREATE INDEX IF NOT EXISTS device_setup_keys_robot_idx ON device_setup_keys (robot_id) WHERE robot_id IS NOT NULL;
