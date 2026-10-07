-- phase: expand
--
-- The one-time conversion of OpenVibe.Live's stream controls into Bot robots (plan T15 R9 step 5):
-- one row per Live control_configs id, so a second conversion run changes nothing and reports it.
-- The row disappears with the robot it records (converting the config again re-creates both).
--
-- detail keeps what the relay plugin needs and the plan reported: the Live command → Bot button-name map
-- (a Bot button name is a normalised, deduplicated form of Live's command string, so the plugin maps back),
-- plus the notes for anything the run could not convert as it stood.
CREATE TABLE live_conversions (
    live_config_id integer PRIMARY KEY,              -- OpenVibe.Live control_configs.id
    robot_id       text NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
    owner_subject  text NOT NULL,                    -- the Live owner's Network subject (usr_…)
    detail         jsonb NOT NULL DEFAULT '{}',
    converted_at   timestamptz NOT NULL
);
