ALTER TABLE projects ADD COLUMN scheduling_policy text
  CHECK(scheduling_policy IS NULL OR scheduling_policy IN ('priority_age','unblocking'));
