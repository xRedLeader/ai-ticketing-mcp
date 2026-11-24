CREATE TABLE knowledge_promotions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  source_project_id uuid NOT NULL REFERENCES projects(id),
  source_knowledge_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK(source_revision>0),
  fact jsonb NOT NULL CHECK(jsonb_typeof(fact)='object'),
  actor_id uuid NOT NULL REFERENCES actors(id),
  created_at timestamptz NOT NULL,
  withdrawn_by uuid REFERENCES actors(id),
  withdrawn_at timestamptz,
  CHECK(project_id<>source_project_id),
  CHECK((withdrawn_by IS NULL)=(withdrawn_at IS NULL)),
  FOREIGN KEY(source_project_id,source_knowledge_id,source_revision) REFERENCES knowledge_revisions(project_id,knowledge_id,revision)
);
CREATE INDEX knowledge_promotions_project ON knowledge_promotions(project_id,created_at,id);
CREATE FUNCTION preserve_knowledge_promotion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Promotion audit cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL OR
    ROW(NEW.id,NEW.project_id,NEW.source_project_id,NEW.source_knowledge_id,NEW.source_revision,NEW.fact,NEW.actor_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.source_project_id,OLD.source_knowledge_id,OLD.source_revision,OLD.fact,OLD.actor_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Only first withdrawal may update promotion audit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER knowledge_promotion_audit BEFORE UPDATE OR DELETE ON knowledge_promotions FOR EACH ROW EXECUTE FUNCTION preserve_knowledge_promotion();
