ALTER TABLE tickets ADD COLUMN work_kind TEXT NOT NULL DEFAULT 'delivery' CHECK(work_kind IN ('delivery','research'));
CREATE INDEX delivery_work_order ON tickets(project_id,priority,created_at,id) WHERE work_kind='delivery' AND status IN ('ready','in_progress');
ALTER TABLE idea_tickets ADD COLUMN spike_ids TEXT NOT NULL DEFAULT '[]';
CREATE TABLE research_spikes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  idea_id TEXT NOT NULL,
  question TEXT NOT NULL,
  time_budget_ms INTEGER NOT NULL CHECK(time_budget_ms BETWEEN 1 AND 604800000),
  first_claimed_at TEXT,
  findings TEXT,
  evidence TEXT NOT NULL,
  recommendation TEXT CHECK(recommendation IN ('promote','park','decline')),
  completed_at TEXT,
  completed_by TEXT REFERENCES actors(id),
  FOREIGN KEY(project_id,id) REFERENCES tickets(project_id,id),
  FOREIGN KEY(project_id,idea_id) REFERENCES ideas(project_id,id),
  CHECK((completed_at IS NULL AND findings IS NULL AND recommendation IS NULL AND completed_by IS NULL) OR
    (completed_at IS NOT NULL AND first_claimed_at IS NOT NULL AND findings IS NOT NULL AND recommendation IS NOT NULL AND completed_by IS NOT NULL AND json_array_length(evidence)>0))
);
CREATE INDEX research_spikes_idea ON research_spikes(project_id,idea_id,id);
CREATE TRIGGER research_spike_immutable_update BEFORE UPDATE ON research_spikes
WHEN OLD.completed_at IS NOT NULL OR (OLD.first_claimed_at IS NOT NULL AND NEW.first_claimed_at IS NOT OLD.first_claimed_at)
BEGIN SELECT RAISE(ABORT,'Research budget anchors and completed results are immutable'); END;
CREATE TRIGGER research_spike_immutable_delete BEFORE DELETE ON research_spikes BEGIN SELECT RAISE(ABORT,'Research results are immutable'); END;
