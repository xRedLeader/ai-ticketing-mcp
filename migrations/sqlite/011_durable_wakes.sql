CREATE TABLE wake_conditions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  condition TEXT NOT NULL CHECK(json_valid(condition) AND json_type(condition)='object'),
  deadline TEXT,
  cursor INTEGER NOT NULL CHECK(cursor>=0),
  revision INTEGER NOT NULL CHECK(revision>0),
  generation INTEGER NOT NULL CHECK(generation>=0),
  observed TEXT NOT NULL CHECK(json_valid(observed) AND json_type(observed)='object'),
  deadline_fired INTEGER NOT NULL CHECK(deadline_fired IN (0,1)),
  pending TEXT NOT NULL CHECK(json_valid(pending) AND json_type(pending)='array'),
  active TEXT,
  finished_token TEXT,
  updated_at TEXT NOT NULL,
  CHECK(id=ticket_id),
  FOREIGN KEY(project_id,ticket_id) REFERENCES tickets(project_id,id)
);
CREATE INDEX wake_conditions_project ON wake_conditions(project_id,id);
