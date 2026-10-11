# Edit application details

The user selected the post-MVP `/edit` upgrade and the established PR workflow.
Keep the existing Discord / Worker / D1 architecture and current commands working.

`/edit application:[owned autocomplete]` opens a prefilled four-field modal:
company and position required, Job URL and notes optional. Blank optional values
clear the saved values. Submit defers privately, updates D1, the existing Forum
post title and starter embed, then confirms with the same post link. Status,
applied date, owner, thread, tags and history remain intact. Saving identical
values makes no Forum mutation. No new buttons, reminders or statistics.

Reuse input validation, autocomplete, embed rendering and REST helpers. Store
each form's snapshot/version and terminal outcome in `application_edits`, keyed
by the command interaction ID. Opening a form does not lock the application;
submission claims the existing nullable `status_change_id` slot shared with
status updates. The legacy column name remains for migration compatibility.
Old forms whose details version changed are rejected. Status-only changes may
occur while a form is open; an edit uses the current status when it claims.
Status claims must also compare details versions to avoid rendering old fields
after an edit completes between their read and claim.

Migration 0003 adds `applications.details_version` (default 0) and the edits
table with old/new details, state, failure stage and original thread metadata.
No new bindings, secrets or services. Valid owned busy/stale submissions retain
terminal outcomes. Duplicate/late deliveries cannot replay an edit. Owner and
mapped Forum are checked at opening and submission; custom IDs alone grant no
access. No tokens stored or raw payloads logged.

Preflight reads validate Forum/thread/guild/parent and metadata before writes.
Temporarily unarchive/unlock as required, rename and update the starter embed,
then restore the original archive/lock state. Safe preflight failures release
the claim. Once any mutation starts, uncertainty retains the claim and old D1
details for manual checking. Persist original metadata for recovery. Private
confirmation failure preserves a completed edit. Public docs contain synthetic
identifiers only, deployment steps, live checks and owner-scoped recovery SQL.

Validation: signed Worker interactions, real isolated D1 migrations/claims,
fictional owners, Request-validated mocked Discord, Node registration tests,
both TypeScript checks, deployment dry-run, and independent whole-change review.
