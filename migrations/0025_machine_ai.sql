-- phase: expand
-- AI on your own machines (contracts 0.219.0, bot.command@1 kind ai; capability bot.machine.ai): the owner lets their
-- AI (OpenVibe.AI, acting for them) run a model on this machine's own model server through OpenVibe Node's ai plugin.
-- Off until they turn it on on openvibe.bot/machines.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS ai_models boolean NOT NULL DEFAULT false;
