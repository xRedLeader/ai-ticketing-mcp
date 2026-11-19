CREATE UNIQUE INDEX notes_execution_identity ON notes(project_id,ticket_id,id);
CREATE TABLE execution_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  checkpoint_id TEXT NOT NULL,
  continuation_id TEXT NOT NULL UNIQUE,
  claim_token TEXT NOT NULL,
  requirements_revision INTEGER NOT NULL CHECK(requirements_revision>0),
  recipe_id TEXT NOT NULL CHECK(length(recipe_id) BETWEEN 1 AND 80),
  recipe_fingerprint TEXT NOT NULL CHECK(length(recipe_fingerprint)=64 AND recipe_fingerprint NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK(status IN ('queued','reserved','running','succeeded','failed')),
  reservation_token TEXT,
  locked_until TEXT,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER CHECK(exit_code BETWEEN -2147483648 AND 4294967295),
  signal TEXT,
  artifacts TEXT NOT NULL CHECK(json_valid(artifacts) AND json_type(artifacts)='array'),
  error_code TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id,ticket_id) REFERENCES tickets(project_id,id),
  FOREIGN KEY(project_id,ticket_id,checkpoint_id) REFERENCES notes(project_id,ticket_id,id),
  FOREIGN KEY(project_id,continuation_id) REFERENCES continuations(project_id,id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(project_id,id), UNIQUE(project_id,ticket_id,id)
);
CREATE TABLE continuations (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  checkpoint_id TEXT NOT NULL,
  requirements_revision INTEGER NOT NULL CHECK(requirements_revision>0),
  completion_condition TEXT NOT NULL CHECK(json_valid(completion_condition) AND json_type(completion_condition)='object'),
  status TEXT NOT NULL CHECK(status IN ('pending','satisfied','failed')),
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  FOREIGN KEY(project_id,ticket_id,run_id) REFERENCES execution_jobs(project_id,ticket_id,id),
  FOREIGN KEY(project_id,ticket_id,checkpoint_id) REFERENCES notes(project_id,ticket_id,id),
  UNIQUE(project_id,id)
);
CREATE INDEX execution_jobs_queue ON execution_jobs(project_id,status,created_at,id);
