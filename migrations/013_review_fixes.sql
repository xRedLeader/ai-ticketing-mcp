CREATE INDEX members_actor ON members(actor_id,id);
CREATE INDEX receipts_created ON receipts(created_at);
-- Ticket search documents now use requirements_revision; rebuild them from authoritative rows.
DELETE FROM search_documents WHERE kind='ticket';
INSERT INTO jobs(id,project_id,entity_id,kind,revision,attempts,available_at)
SELECT 'ticket:'||id,project_id,id,'ticket',requirements_revision,0,now() FROM tickets
ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,attempts=0,available_at=now(),locked_until=NULL,lock_token=NULL,last_error=NULL;
