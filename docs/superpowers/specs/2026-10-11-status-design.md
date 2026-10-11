# M6 status design

Extend the existing private Discord tracker with only `/status application:… status:…`.
The handoff defines seven statuses: Applied, Screening, Assessment, Interview,
Offer, Rejected, Withdrawn. Every suggestion and update belongs to the invoking
guild member and their configured Forum. No new service, secret, dashboard, or
background scheduler is introduced.

Autocomplete returns at most 25 completed applications, searches company/position
literally, bounds labels to 100 UTF-16 units, and returns no data for unauthorized
requests. Status commands validate both options and immediately defer privately.

Use a small `status_changes` table keyed by interaction ID and one nullable
`applications.status_change_id` claim column. A D1 batch atomically records and
claims a change. This prevents simultaneous updates and replayed interactions,
including old replays after later changes. Pending creation records are excluded.

Before mutating Discord, validate the Forum, thread parent/guild, tags and metadata.
Replace every recognized status tag with the chosen one, preserving other tags
within Discord's five-tag limit. Update the starter embed from the saved application
and write one `Old → New` history message with mentions disabled and a nonce.
Temporarily unarchive/unlock when necessary, restoring the original archive/lock
state afterward. Commit the D1 status only after Discord finishes.

Failures before writes release the claim and retain a failed attempt. Failures
after writes begin retain a `needs_check` attempt and its claim; no automatic
replay of uncertain writes. Return a private explanation/reference. Identical
statuses produce no Discord writes or history. Successful duplicate requests only
repeat the private confirmation. A failed confirmation never rolls back success.

Success requires tests with real D1 and real Workers Request validation, both-user
fixtures, concurrency/replay/ownership/API failure coverage, CLI registration tests,
TypeScript checks, dry-run, independent review and a user-run live deployment check.

The new migration preserves existing applications. User IDs and Forum IDs remain
private secrets; public code/docs/tests contain only placeholders or fictional IDs.
