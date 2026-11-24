CREATE TABLE branch_dispatches (
id uuid PRIMARY KEY,
project_id uuid NOT NULL REFERENCES projects(id),
actor_id uuid NOT NULL REFERENCES actors(id),
claim_token uuid NOT NULL,
requirements_revision integer NOT NULL CHECK(requirements_revision>0),
capacity_id uuid NOT NULL,
budget_run_id text NOT NULL,
host_id text NOT NULL,
dispatch jsonb NOT NULL CHECK(jsonb_typeof(dispatch)='object'),
FOREIGN KEY(project_id,id) REFERENCES tickets(project_id,id)
);
