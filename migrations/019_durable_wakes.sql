CREATE TABLE wake_conditions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  ticket_id uuid NOT NULL UNIQUE REFERENCES tickets(id),
  actor_id uuid NOT NULL REFERENCES actors(id),
  condition jsonb NOT NULL CHECK(jsonb_typeof(condition)='object'),
  deadline timestamptz,
  cursor bigint NOT NULL CHECK(cursor>=0),
  revision integer NOT NULL CHECK(revision>0),
  generation integer NOT NULL CHECK(generation>=0),
  observed jsonb NOT NULL CHECK(jsonb_typeof(observed)='object'),
  deadline_fired boolean NOT NULL,
  pending jsonb NOT NULL CHECK(jsonb_typeof(pending)='array'),
  active jsonb,
  finished_token uuid,
  updated_at timestamptz NOT NULL,
  CHECK(id=ticket_id),
  FOREIGN KEY(project_id,ticket_id) REFERENCES tickets(project_id,id)
);
CREATE INDEX wake_conditions_project ON wake_conditions(project_id,id);
