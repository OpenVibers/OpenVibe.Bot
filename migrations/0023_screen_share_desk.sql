-- phase: expand
-- A screen share link shows the owner's own screen (main) or the machine's private desk (contracts 0.214.0 bot.command@1
-- `desk: private`, OpenVibe.Node v0.15.0): the agent works on the desk, and a room watches it there, never the owner's
-- screen. Links made before this show the owner's screen, as they did.
ALTER TABLE machine_screen_shares ADD COLUMN IF NOT EXISTS desk text NOT NULL DEFAULT 'main' CHECK (desk IN ('main', 'private'));
