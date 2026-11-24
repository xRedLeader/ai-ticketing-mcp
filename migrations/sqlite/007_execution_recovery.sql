CREATE TABLE execution_controllers (
  id TEXT PRIMARY KEY CHECK(id='execution'),
  owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 200),
  token TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>0),
  expires_at TEXT NOT NULL
);
-- A permanent singleton also fences direct legacy callers during the first acquisition.
INSERT INTO execution_controllers VALUES('execution','unclaimed','00000000-0000-0000-0000-000000000000',1,'1970-01-01T00:00:00.000Z');
CREATE TABLE execution_attempts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  previous_attempt_id TEXT REFERENCES execution_attempts(id),
  ordinal INTEGER NOT NULL CHECK(ordinal>0),
  process_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id,run_id) REFERENCES execution_jobs(project_id,id),
  UNIQUE(project_id,run_id,id)
);
CREATE TABLE execution_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  controller_generation INTEGER NOT NULL CHECK(controller_generation>=0),
  kind TEXT NOT NULL CHECK(kind IN ('reserved','dispatching','running','completed','unresolved')),
  next_step TEXT NOT NULL CHECK(next_step IN ('dispatch','inspect_launch','wait_for_result','inspect_side_effects','none')),
  process_identity TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id,run_id,attempt_id) REFERENCES execution_attempts(project_id,run_id,id),
  UNIQUE(attempt_id,sequence)
);
CREATE INDEX execution_observations_latest ON execution_observations(attempt_id,sequence DESC);
CREATE TRIGGER execution_attempt_no_update BEFORE UPDATE ON execution_attempts BEGIN SELECT RAISE(ABORT,'Execution history is immutable'); END;
CREATE TRIGGER execution_attempt_no_delete BEFORE DELETE ON execution_attempts BEGIN SELECT RAISE(ABORT,'Execution history is immutable'); END;
CREATE TRIGGER execution_observation_no_update BEFORE UPDATE ON execution_observations BEGIN SELECT RAISE(ABORT,'Execution history is immutable'); END;
CREATE TRIGGER execution_observation_no_delete BEFORE DELETE ON execution_observations BEGIN SELECT RAISE(ABORT,'Execution history is immutable'); END;
