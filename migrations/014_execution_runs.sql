CREATE UNIQUE INDEX notes_execution_identity ON notes(project_id,ticket_id,id);
CREATE TABLE execution_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES actors(id),
  checkpoint_id uuid NOT NULL,
  continuation_id uuid NOT NULL UNIQUE,
  claim_token uuid NOT NULL,
  requirements_revision integer NOT NULL CHECK(requirements_revision>0),
  recipe_id text NOT NULL CHECK(length(recipe_id) BETWEEN 1 AND 80),
  recipe_fingerprint text NOT NULL CHECK(recipe_fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN ('queued','reserved','running','succeeded','failed')),
  reservation_token uuid,
  locked_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  exit_code bigint CHECK(exit_code BETWEEN -2147483648 AND 4294967295),
  signal text,
  artifacts jsonb NOT NULL CHECK(jsonb_typeof(artifacts)='array'),
  error_code text,
  created_at timestamptz NOT NULL,
  FOREIGN KEY(project_id,ticket_id) REFERENCES tickets(project_id,id),
  FOREIGN KEY(project_id,ticket_id,checkpoint_id) REFERENCES notes(project_id,ticket_id,id),
  UNIQUE(project_id,id), UNIQUE(project_id,ticket_id,id)
);
CREATE TABLE continuations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  run_id uuid NOT NULL UNIQUE,
  checkpoint_id uuid NOT NULL,
  requirements_revision integer NOT NULL CHECK(requirements_revision>0),
  completion_condition jsonb NOT NULL CHECK(jsonb_typeof(completion_condition)='object'),
  status text NOT NULL CHECK(status IN ('pending','satisfied','failed')),
  failure_reason text,
  created_at timestamptz NOT NULL,
  settled_at timestamptz,
  FOREIGN KEY(project_id,ticket_id,run_id) REFERENCES execution_jobs(project_id,ticket_id,id),
  FOREIGN KEY(project_id,ticket_id,checkpoint_id) REFERENCES notes(project_id,ticket_id,id),
  UNIQUE(project_id,id)
);
ALTER TABLE execution_jobs ADD CONSTRAINT execution_continuation FOREIGN KEY(project_id,continuation_id) REFERENCES continuations(project_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX execution_jobs_queue ON execution_jobs(project_id,status,created_at,id);
