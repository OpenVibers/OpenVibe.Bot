-- phase: expand
-- Plan L34 (the machines hub): the roles a machine has for the network (the catalogue is Contracts 0.257.0's
-- machineRoles: codes.worker, desks.host, ai.host, bot.robot). The owner sets them on openvibe.network/machines and
-- the Node reads them on its next check-in (the config frame carries them). A machine that never had a role has the
-- empty list, which is what the column starts with.
ALTER TABLE devices ADD COLUMN roles jsonb NOT NULL DEFAULT '[]'::jsonb;
