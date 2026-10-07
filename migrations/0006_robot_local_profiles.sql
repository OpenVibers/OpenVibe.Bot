-- phase: expand
-- Robot-owned profiles share the validated profile store with shipped catalogue profiles.
-- A local row belongs to exactly one robot and disappears with it.
ALTER TABLE robot_profiles ADD COLUMN robot_id text REFERENCES robots(id) ON DELETE CASCADE;
ALTER TABLE robot_profiles ADD COLUMN source_profile_id text;
ALTER TABLE robot_profiles ADD CONSTRAINT robot_profiles_local_id CHECK
    (robot_id IS NULL OR (id = 'local.' || lower(robot_id) AND source_profile_id IS NOT NULL));
CREATE UNIQUE INDEX robot_profiles_one_local ON robot_profiles (robot_id) WHERE robot_id IS NOT NULL;
