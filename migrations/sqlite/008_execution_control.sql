CREATE TABLE execution_admissions (
  id TEXT PRIMARY KEY REFERENCES projects(id),
  paused INTEGER NOT NULL CHECK(paused IN (0,1)),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  updated_at TEXT NOT NULL
);
CREATE TABLE execution_cancellations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES actors(id),
  requested_at TEXT NOT NULL,
  process_state TEXT NOT NULL CHECK(process_state IN ('requested','never_started','exit_confirmed','unresolved')),
  effects_state TEXT NOT NULL CHECK(effects_state IN ('not_started','unresolved','reconciled')),
  reconciliation_note TEXT CHECK(length(reconciliation_note) BETWEEN 1 AND 4000),
  reconciled_by TEXT REFERENCES actors(id),
  reconciled_at TEXT,
  FOREIGN KEY(project_id,id) REFERENCES execution_jobs(project_id,id)
);
