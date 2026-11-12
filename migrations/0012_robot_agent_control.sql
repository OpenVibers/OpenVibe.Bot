-- phase: expand
--
-- The owner's agent (plan T15 "an Actor agent can pilot a robot under the owner's grant", always through Bot): with
-- agent_control on, the owner's OpenVibe.Actor agent may send this robot commands as the owner (Actor's service token,
-- grant bot.robot.control, X-OV-Subject = the owner). Bot's gate, limits and e-stop still decide every command; the
-- device's deadman still stops it. Off for every robot until its owner turns it on. Additive only.

ALTER TABLE robots ADD COLUMN agent_control boolean NOT NULL DEFAULT false;
