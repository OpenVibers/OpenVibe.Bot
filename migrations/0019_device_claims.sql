-- phase: expand
-- A device that asks to be added (the installer run with no pairing code: `curl -fsSL https://openvibe.bot/install | sh`).
-- It shows a code; a signed-in person enters it on /link, sees what the device found, and approves or denies it. An
-- approval makes the robot (server/claims.js) and leaves its pairing here for the device, which polls with its secret;
-- the pairing goes once the device has paired. Rows are short-lived (15 minutes to approve; pruned after a day).
CREATE TABLE IF NOT EXISTS device_claims (
    id                text PRIMARY KEY,                        -- clm_…
    user_code_hash    text NOT NULL UNIQUE,                    -- sha256 of the code the device shows (XXXX-XXXX, normalised)
    secret_hash       text NOT NULL,                           -- sha256 of the device's poll secret
    hostname          text NOT NULL,
    hardware          jsonb NOT NULL DEFAULT '{}'::jsonb,      -- what the installer found: shown (escaped), never acted on
    suggested_profile text,                                    -- the catalogue profile that detection names, if any
    address           text,                                    -- the address the claim came from, shown to the approver
    state             text NOT NULL DEFAULT 'pending',         -- pending, approving, approved, denied, paired
    owner_subject     text,                                    -- who approved or denied it
    robot_id          text,                                    -- the robot the approval made
    pairing           jsonb,                                   -- that robot's pairing for the device, until it pairs
    want_live         boolean NOT NULL DEFAULT false,          -- the owner asked for the robot's video on their Live channel
    live_applied_at   timestamptz,
    created_at        timestamptz NOT NULL,
    expires_at        timestamptz NOT NULL,
    decided_at        timestamptz,
    paired_at         timestamptz
);
CREATE INDEX IF NOT EXISTS device_claims_robot_idx ON device_claims (robot_id) WHERE robot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS device_claims_expires_idx ON device_claims (expires_at);
