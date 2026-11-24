ALTER TABLE knowledge DROP CONSTRAINT knowledge_kind_check;
ALTER TABLE knowledge ADD CONSTRAINT knowledge_kind_check CHECK(kind IN ('policy','decision','convention','pitfall','runbook','architecture','note'));
ALTER TABLE knowledge ADD COLUMN sources jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(sources)='array');
ALTER TABLE knowledge ADD COLUMN status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','accepted'));
ALTER TABLE knowledge ADD COLUMN verification jsonb NOT NULL DEFAULT '{"state":"unverified"}' CHECK(jsonb_typeof(verification)='object' AND verification->>'state' IS NOT NULL AND verification->>'state' IN ('unverified','verified'));
ALTER TABLE knowledge ADD CONSTRAINT knowledge_acceptance CHECK(status<>'accepted' OR (verification->>'state'='verified' AND jsonb_array_length(sources)>0));
ALTER TABLE knowledge ADD CONSTRAINT knowledge_project_identity UNIQUE(project_id,id);
CREATE TABLE knowledge_revisions (
  id text PRIMARY KEY,
  knowledge_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('policy','decision','convention','pitfall','runbook','architecture','note')),
  sources jsonb NOT NULL CHECK(jsonb_typeof(sources)='array'),
  status text NOT NULL CHECK(status IN ('proposed','accepted')),
  verification jsonb NOT NULL CHECK(jsonb_typeof(verification)='object' AND verification->>'state' IS NOT NULL AND verification->>'state' IN ('unverified','verified')),
  revision integer NOT NULL CHECK(revision>0),
  archived boolean NOT NULL,
  actor_id uuid NOT NULL REFERENCES actors(id),
  updated_at timestamptz NOT NULL,
  FOREIGN KEY(project_id,knowledge_id) REFERENCES knowledge(project_id,id),
  UNIQUE(project_id,knowledge_id,revision),
  CHECK(id=knowledge_id::text||':'||revision::text),
  CHECK(status<>'accepted' OR (verification->>'state'='verified' AND jsonb_array_length(sources)>0))
);
INSERT INTO knowledge_revisions(id,knowledge_id,project_id,title,body,kind,sources,status,verification,revision,archived,actor_id,updated_at)
SELECT id::text||':'||revision::text,id,project_id,title,body,kind,sources,status,verification,revision,archived,actor_id,updated_at FROM knowledge;
CREATE FUNCTION immutable_knowledge_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Knowledge revisions are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER knowledge_revision_immutable BEFORE UPDATE OR DELETE ON knowledge_revisions FOR EACH ROW EXECUTE FUNCTION immutable_knowledge_revision();
