-- phase: expand
-- Plan T18 step 7 (contracts 0.167.0): the owner lets their watches (OpenVibe.Watch's node source) check things on
-- this machine's own network with the computer plugin's read-only `probe`. Off until the owner turns it on, on
-- openvibe.bot/machines; Watch may send nothing else.
ALTER TABLE devices ADD COLUMN watch_probe boolean NOT NULL DEFAULT false;
