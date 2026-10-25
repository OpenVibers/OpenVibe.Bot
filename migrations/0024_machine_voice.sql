-- phase: expand
-- Vibe by voice (consumer plan §8, contracts 0.214.0 bot.device-message@1 voice_ask / voice_answer): the owner lets
-- Vibe answer their voice on this machine, and chooses its call word. Off until they turn it on on openvibe.bot/machines;
-- the machine (OpenVibe Node's voice plugin) listens for the word only while it is on (config `voice`).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS voice_on boolean NOT NULL DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS call_word text;
