-- phase: expand
-- Crowd control (plan §H2, Maticus's mixer): a robot may be driven by everyone in its panel at once, their drives mixed
-- into one command (server/crowd/). The fourth access policy; the crowd's style, window and cap live in robots.limits.
ALTER TABLE robots DROP CONSTRAINT IF EXISTS robots_access_policy_check;
ALTER TABLE robots ADD CONSTRAINT robots_access_policy_check CHECK (access_policy IN ('private', 'invite', 'queue', 'crowd'));
