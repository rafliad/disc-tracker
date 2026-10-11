-- Keep an editable-details revision separate from status updates.
ALTER TABLE applications ADD COLUMN details_version INTEGER NOT NULL DEFAULT 0 CHECK (details_version >= 0);

CREATE TABLE application_edits (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    base_version INTEGER NOT NULL CHECK (base_version >= 0),
    before_details TEXT NOT NULL,
    after_details TEXT,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','pending','complete','failed','needs_check')),
    failure_stage TEXT,
    thread_metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX application_edits_application_idx ON application_edits(application_id, created_at);
