-- phase: expand
--
-- Community robot profiles (plan T15 "people submit bots and guides and Bot connects them"): anyone signed in submits a
-- profile (its id under community.), with the driver's source, a setup guide and a licence; an OpenVibe admin reviews
-- it. An approved one is signed by Bot (Ed25519 over its canonical JSON, BOT_PROFILE_SIGNING_KEY) and joins the
-- catalogue (robot_profiles), so robots can be added with it. Additive only.
--
-- Account deletion (ADR-033): a person's pending and rejected submissions are deleted; an approved one stays in the
-- catalogue (robots may use it) with submitter_subject cleared.

CREATE TABLE IF NOT EXISTS profile_submissions (
    id                text PRIMARY KEY,                                   -- sub_…
    submitter_subject text,                                               -- usr_…; NULL once the account is deleted
    profile_id        text NOT NULL,                                      -- community.…
    profile_version   integer NOT NULL,
    profile           jsonb NOT NULL,                                     -- validated bot.robot-profile@1
    driver_url        text,                                               -- the driver's source (https)
    guide_url         text,                                               -- the setup guide (https)
    license           text,
    notes             text,
    status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    review_note       text,
    reviewed_by       text,
    reviewed_at       timestamptz,
    signature         text,                                               -- base64 Ed25519 signature, on approval
    key_id            text,                                               -- which signing key made it
    created_at        timestamptz NOT NULL,
    updated_at        timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS profile_submissions_status_idx ON profile_submissions (status, created_at);
CREATE INDEX IF NOT EXISTS profile_submissions_submitter_idx ON profile_submissions (submitter_subject);
CREATE UNIQUE INDEX IF NOT EXISTS profile_submissions_approved_one ON profile_submissions (profile_id, profile_version) WHERE status = 'approved';
