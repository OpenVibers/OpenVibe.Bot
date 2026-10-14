-- phase: expand
-- Plan T14/T17: the owner lets their agent (OpenVibe.Actor, bot.computer.control) use this machine's computer plugin
-- (terminal, files, screen). Off until the owner turns it on, on openvibe.bot/machines; the machine's own control level
-- (set on the machine) still decides what may happen there.
ALTER TABLE devices ADD COLUMN agent_computer boolean NOT NULL DEFAULT false;
