ALTER TABLE tickets ADD COLUMN work_kind text NOT NULL DEFAULT 'delivery' CHECK(work_kind IN ('delivery','research'));
CREATE INDEX delivery_work_order ON tickets(project_id,priority,created_at,id) WHERE work_kind='delivery' AND status IN ('ready','in_progress');
ALTER TABLE idea_tickets ADD COLUMN spike_ids jsonb NOT NULL DEFAULT '[]';
CREATE TABLE research_spikes (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  idea_id uuid NOT NULL,
  question text NOT NULL,
  time_budget_ms integer NOT NULL CHECK(time_budget_ms BETWEEN 1 AND 604800000),
  first_claimed_at timestamptz,
  findings text,
  evidence jsonb NOT NULL,
  recommendation text CHECK(recommendation IN ('promote','park','decline')),
  completed_at timestamptz,
  completed_by uuid REFERENCES actors(id),
  FOREIGN KEY(project_id,id) REFERENCES tickets(project_id,id),
  FOREIGN KEY(project_id,idea_id) REFERENCES ideas(project_id,id),
  CHECK((completed_at IS NULL AND findings IS NULL AND recommendation IS NULL AND completed_by IS NULL) OR
    (completed_at IS NOT NULL AND first_claimed_at IS NOT NULL AND findings IS NOT NULL AND recommendation IS NOT NULL AND completed_by IS NOT NULL AND jsonb_array_length(evidence)>0))
);
CREATE INDEX research_spikes_idea ON research_spikes(project_id,idea_id,id);
CREATE FUNCTION immutable_spike_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR OLD.completed_at IS NOT NULL OR (OLD.first_claimed_at IS NOT NULL AND NEW.first_claimed_at IS DISTINCT FROM OLD.first_claimed_at) THEN
    RAISE EXCEPTION 'Research budget anchors and completed results are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER research_spike_immutable BEFORE UPDATE OR DELETE ON research_spikes FOR EACH ROW EXECUTE FUNCTION immutable_spike_result();
