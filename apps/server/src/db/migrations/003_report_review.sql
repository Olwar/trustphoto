-- A report is open until the operator removes the photo or dismisses it (scripts/moderate.ts).
ALTER TABLE reports ADD COLUMN closed_at timestamptz;
ALTER TABLE reports ADD COLUMN details text CHECK (char_length(details) <= 500);
CREATE INDEX reports_open ON reports (photo_id) WHERE closed_at IS NULL;
