CREATE TABLE execution_admissions (
  id uuid PRIMARY KEY REFERENCES projects(id),
  paused boolean NOT NULL,
  actor_id uuid NOT NULL REFERENCES actors(id),
  updated_at timestamptz NOT NULL
);
CREATE TABLE execution_cancellations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES actors(id),
  requested_at timestamptz NOT NULL,
  process_state text NOT NULL CHECK(process_state IN ('requested','never_started','exit_confirmed','unresolved')),
  effects_state text NOT NULL CHECK(effects_state IN ('not_started','unresolved','reconciled')),
  reconciliation_note text CHECK(length(reconciliation_note) BETWEEN 1 AND 4000),
  reconciled_by uuid REFERENCES actors(id),
  reconciled_at timestamptz,
  FOREIGN KEY(project_id,id) REFERENCES execution_jobs(project_id,id)
);
