CREATE TABLE execution_controllers (
  id text PRIMARY KEY CHECK(id='execution'),
  owner_id text NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 200),
  token uuid NOT NULL,
  generation integer NOT NULL CHECK(generation>0),
  expires_at timestamptz NOT NULL
);
-- A permanent singleton also fences direct legacy callers during the first acquisition.
INSERT INTO execution_controllers VALUES('execution','unclaimed','00000000-0000-0000-0000-000000000000',1,'1970-01-01T00:00:00.000Z');
CREATE TABLE execution_attempts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL UNIQUE,
  previous_attempt_id uuid REFERENCES execution_attempts(id),
  ordinal integer NOT NULL CHECK(ordinal>0),
  process_token uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  FOREIGN KEY(project_id,run_id) REFERENCES execution_jobs(project_id,id),
  UNIQUE(project_id,run_id,id)
);
CREATE TABLE execution_observations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  sequence integer NOT NULL CHECK(sequence>0),
  controller_generation integer NOT NULL CHECK(controller_generation>=0),
  kind text NOT NULL CHECK(kind IN ('reserved','dispatching','running','completed','unresolved')),
  next_step text NOT NULL CHECK(next_step IN ('dispatch','inspect_launch','wait_for_result','inspect_side_effects','none')),
  process_identity jsonb,
  outcome jsonb,
  created_at timestamptz NOT NULL,
  FOREIGN KEY(project_id,run_id,attempt_id) REFERENCES execution_attempts(project_id,run_id,id),
  UNIQUE(attempt_id,sequence)
);
CREATE INDEX execution_observations_latest ON execution_observations(attempt_id,sequence DESC);
CREATE FUNCTION immutable_execution_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Execution history is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER execution_attempt_immutable BEFORE UPDATE OR DELETE ON execution_attempts FOR EACH ROW EXECUTE FUNCTION immutable_execution_history();
CREATE TRIGGER execution_observation_immutable BEFORE UPDATE OR DELETE ON execution_observations FOR EACH ROW EXECUTE FUNCTION immutable_execution_history();
