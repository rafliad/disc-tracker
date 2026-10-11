-- Discord snowflakes stay TEXT to avoid JavaScript integer precision loss.
CREATE TABLE applications (
    id TEXT PRIMARY KEY NOT NULL,
    owner_discord_id TEXT NOT NULL,
    forum_channel_id TEXT NOT NULL,
    -- NULL while forum creation is pending; a thread can belong to only one application.
    discord_thread_id TEXT UNIQUE,
    company TEXT NOT NULL CHECK (length(trim(company)) > 0),
    position TEXT NOT NULL CHECK (length(trim(position)) > 0),
    job_url TEXT,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'Applied'
        CHECK (status IN ('Applied', 'Screening', 'Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn')),
    applied_at TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX applications_owner_updated_idx ON applications (owner_discord_id, updated_at DESC);
