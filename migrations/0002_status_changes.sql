-- One durable claim per application; attempts stay keyed by Discord interaction ID.
ALTER TABLE applications ADD COLUMN status_change_id TEXT;

CREATE TABLE status_changes (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    from_status TEXT NOT NULL CHECK (from_status IN ('Applied','Screening','Assessment','Interview','Offer','Rejected','Withdrawn')),
    to_status TEXT NOT NULL CHECK (to_status IN ('Applied','Screening','Assessment','Interview','Offer','Rejected','Withdrawn')),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','complete','failed','needs_check')),
    failure_stage TEXT,
    history_message_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX status_changes_application_idx ON status_changes(application_id, created_at);
