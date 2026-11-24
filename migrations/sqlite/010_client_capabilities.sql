ALTER TABLE claims ADD COLUMN execution TEXT CHECK(execution IS NULL OR json_valid(execution));
