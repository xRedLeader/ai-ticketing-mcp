ALTER TABLE search_vectors ADD COLUMN input_hash text
  CHECK (input_hash IS NULL OR input_hash ~ '^[a-f0-9]{64}$');
