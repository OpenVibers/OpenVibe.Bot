-- phase: expand
-- What a machine's coding agents have left (Codes C9c, bot.device-message@1's heartbeat `fleet`): each agent's id,
-- whether it is installed and signed in, and each limit window's label, what it has used of its limit, and when it
-- frees. Its OpenVibe.Node reads it with OpenVibe.Codes' own logins probe as the machine's user and reports labels,
-- numbers and times only: no key, token or account name. Bot keeps the latest reading per machine and when it stored
-- it; a machine that stops beating keeps its last reading, and fleet_at says how old it is.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fleet jsonb;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fleet_at timestamptz;
