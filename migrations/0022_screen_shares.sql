-- phase: expand
-- Screen share links (server/screen-shares.js; owner 2026-10-25: a screen people watch and use together, in a room).
-- A machine's owner makes a link to its live screen: watch only, or watch and use (the mouse and keyboard, at the level
-- the owner set on the machine). The link is shown once; Bot keeps only its hash. Revoking, removing the machine or the
-- end date stops it at once.
CREATE TABLE IF NOT EXISTS machine_screen_shares (
    id             text PRIMARY KEY,                    -- shr_<ULID>
    device_id      text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    owner_subject  text NOT NULL,
    token_hash     text NOT NULL UNIQUE,                -- sha256 of the link's token
    label          text,                                -- where the owner put it ("staff room")
    control        boolean NOT NULL DEFAULT false,      -- true: holders may use the mouse and keyboard
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz,
    revoked_at     timestamptz,
    last_used_at   timestamptz
);
CREATE INDEX IF NOT EXISTS machine_screen_shares_device_idx ON machine_screen_shares (device_id) WHERE revoked_at IS NULL;
