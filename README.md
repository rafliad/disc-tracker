# Discord Job Application Tracker

A private Discord job application tracker for two users. The intended MVP uses
`/apply`, `/status`, separate Discord Forum Channels, and Cloudflare D1.

## Current milestone: M6

This change implements the Discord Interactions endpoint at the Worker's root URL:

- `GET /`: returns `Job Tracker is running!` as a health check.
- `POST /`: verifies Discord's Ed25519 signature against the timestamp and exact
  request body before parsing JSON. Unsigned or invalid signatures return HTTP 401.
- A correctly signed PING (`type: 1`) returns HTTP 200 and JSON `{ "type": 1 }`.
- A correctly signed `/test` from a configured member in the configured server
  checks the D1 binding and application table, then privately confirms connection,
  database readiness, and that member's configured Forum.
- Unknown members and requests from another server receive a private denial.
  Guild identity comes from `member.user.id`; the DM `user` field is never used
  to authorize guild commands. Authorization happens before any database query.
- `/apply` opens an owner-bound modal. A valid submission is acknowledged
  privately immediately, then saved to D1 and posted to that user's Forum with
  its `Applied` tag. The private confirmation links to the new post.
- `/status application:… status:…` suggests only that member's saved applications.
  It privately defers, updates the Forum tag and starter status, writes a history
  message, and commits the new D1 status. Duplicate and concurrent requests are guarded.
- Signed malformed payloads and interaction types not implemented yet return 400.
- A missing or malformed configured public key returns 500 for a signed request.
- Other paths return 404; unsupported methods at `/` return 405.

M3 endpoint registration and M4's live database/Forum `/test` reply have been
confirmed by the project owner. M5 `/apply` also passed its live check after fixing
the Worker redirect option and correcting the private Forum mapping. M6 adds
`/status`; its live checks remain to be done after deployment.

## Deploy and try `/status` (M6)

After merging, run from your existing project folder:

```powershell
git switch master
git pull --ff-only origin master
npm ci
npm test -- --run
npm run test:scripts
npx tsc --noEmit
npx tsc --noEmit -p test/tsconfig.json
npx wrangler d1 migrations apply disc-tracker-db --remote
npm run deploy
npm run register:status -- YOUR_SERVER_ID
```

Migration `0002_status_changes.sql` preserves existing applications and adds
durable change attempts plus a nullable claim. Apply it before deploying M6.
There are no new bindings or secrets. Registration reads your existing local
credentials and upserts only `/status`, preserving `/apply` and `/test`.

Both Forums need exactly one tag for each of these names: **Applied, Screening,
Assessment, Interview, Offer, Rejected, Withdrawn**. Check the bot's permissions
in both Forums: View Channel, Send Messages, Send Messages in Threads, Embed
Links, Read Message History, and Manage Threads. Administrator is not required.

1. Use `/status`, start typing your test company's name in `application`, then
   select the suggested application. Search matches literal company/position
   text; SQLite's built-in case folding handles ASCII. Up to 25 recent results
   appear, with date, status and an ID suffix to distinguish similar applications.
2. Choose `Screening`. Expect a private **Status updated — Screening** reply.
3. Check the post: exactly one status tag, `Screening` in the starter embed, and
   an **Applied → Screening** history message. Other tags and application fields remain.
4. Choose `Interview`, then `Offer`, and check each history entry.
5. Select the current status again: no duplicate history should appear.
6. Archive a test post, then update its status. It should update and be archived
   again afterward. A locked post requires Manage Threads; its lock is restored too.
7. Your friend's route and denied cross-owner updates are covered with fictional
   fixtures. A live friend check can wait until they join; these setup steps do
   not invite or message them.

After these checks, the intended MVP is complete. Use it before adding features.

## Status failures and recovery

Only fully linked applications in the owner's configured Forum are selectable.
Pending status changes are hidden from autocomplete. Every update rechecks
ownership; manually supplied application IDs cannot bypass it. Unexpected thread
parents, guilds, tag definitions or tag counts stop the change before writes.

A durable claim serializes each application. Completed interaction IDs never
replay updates, even after newer changes. Busy and claim-losing requests also retain terminal attempts, so their later redelivery cannot change a newer status. Selecting an unchanged status makes no
Discord writes. History suppresses mentions and supplies a nonce as an additional
Discord guard; it does not rely on the nonce's short retention for durable deduplication.

| Failure | Result |
| --- | --- |
| Database or initial validation | No Discord writes; private explanation. |
| Forum/thread preflight | Attempt marked `failed`, claim released; fix setup and run `/status` again. |
| Any mutation begins, then REST/network/commit fails | Attempt becomes `needs_check`; old D1 status and claim remain; private post link/reference. Do not repeat until checked. |
| Worker ends unexpectedly | A `pending` attempt/claim can remain; check it before releasing. |
| Final private reply fails | Completed change remains; safe HTTP/code/category diagnostics are logged. |

For a retained claim, inspect the application and attempt in D1 using its reference
and the owner's ID. Check the post's status tag, starter embed, history and
archive/lock state. Do not release a claim while that invocation is still running.
If changes are partial, manually make the three status displays agree with either
`from_status` or `to_status`; verify history without blindly posting another entry.
A known history message ID is saved on the attempt when available. A timeout can
leave a message that was created but whose ID wasn't received.

Once Discord is confirmed consistent, resolve that specific attempt in the
Cloudflare D1 console. Replace placeholders only after checking both systems:

```sql
-- Inspect first; this query also enforces owner association.
SELECT a.id, a.status, a.status_change_id, a.discord_thread_id,
       c.from_status, c.to_status, c.state, c.failure_stage, c.history_message_id
FROM applications a JOIN status_changes c ON c.id = a.status_change_id
WHERE a.owner_discord_id = 'OWNER_ID' AND c.id = 'CHANGE_REFERENCE';

-- FINAL_STATUS must be exactly the confirmed from_status or to_status.
UPDATE applications SET status = 'FINAL_STATUS', status_change_id = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id = 'APPLICATION_ID' AND owner_discord_id = 'OWNER_ID'
  AND status_change_id = 'CHANGE_REFERENCE'
  AND EXISTS (SELECT 1 FROM status_changes c WHERE c.id = 'CHANGE_REFERENCE'
      AND c.application_id = applications.id AND c.state IN ('pending','needs_check')
      AND 'FINAL_STATUS' IN (c.from_status,c.to_status));

-- RESOLUTION is complete if FINAL_STATUS is to_status, otherwise failed.
UPDATE status_changes SET state = 'RESOLUTION',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id = 'CHANGE_REFERENCE' AND application_id = 'APPLICATION_ID'
  AND state IN ('pending','needs_check')
  AND EXISTS (SELECT 1 FROM applications a WHERE a.id = status_changes.application_id
      AND a.owner_discord_id = 'OWNER_ID' AND a.status_change_id IS NULL
      AND a.status = 'FINAL_STATUS');
```

Run these individually and check affected rows. The two manual updates are an
operator procedure, not an automatic retry; do not execute another status command
between them. Neither step deletes applications, posts, or history.

## Deploy and try `/apply` (M5)

After merging, pull the changes into your existing project folder. If Git reports
uncommitted changes, keep and resolve those edits before switching or pulling.

```powershell
git switch master
git pull --ff-only origin master
npm ci
npm test -- --run
npm run test:scripts
npx tsc --noEmit
npx tsc --noEmit -p test/tsconfig.json
npm run deploy
npm run register:apply -- YOUR_SERVER_ID
```

Replace `YOUR_SERVER_ID` with your existing server ID. Registration reads the
existing local Bot Token and Application ID from `.dev.vars` (Node.js 22 or newer).
It creates/updates only this guild's `/apply` and preserves `/test` and other
commands. Keep the existing production secrets and Interactions Endpoint URL.
M5 adds no new secrets or migrations; it uses M4's existing application table.

Each configured Forum must have **exactly one tag named `Applied`**. The Worker
reads that Forum's tags from Discord when saving an application, so tag IDs do not
need to be copied or stored. The channel must be a Forum in the configured server,
and the bot needs permission to view it, send messages/create Forum posts, and
embed links. Applying moderated tags also requires Manage Threads permission.

In your bot command channel:

1. Run `/test` and confirm database readiness and your Forum.
2. Select this app's `/apply` command. The modal contains Company and Position
   (required, up to 100 characters each), Job URL (optional, up to 1000), and Notes
   (optional, up to 2000).
3. Try Company `Example Company`, Position `Software Engineer`, a valid HTTPS
   job URL, and a short note. Submit once.
4. Expect a private **Application saved — Applied** reply with a post link.
5. Open that link and verify it is in your Forum, has the `Applied` tag, and shows
   the company, position, date, URL, and notes. The date uses **Asia/Jakarta**;
   database creation/update timestamps remain UTC.
6. Try a second application with URL and Notes left empty. It should save too.

You can do these live checks yourself; your friend does not need to join yet.
Automated tests cover both routes using fictional IDs and mocked Discord requests.
Running the tests sends no messages or registration requests to Discord.

Worker tests validate every outbound request with the real Workers `Request`
constructor before mocking network I/O. Worker Discord calls use `redirect:
'manual'`: Workers rejects `redirect: 'error'`, and unexpected redirects are
handled as failures without forwarding credentials to another URL. The Node.js
registration scripts retain their supported `redirect: 'error'` setting.

## `/apply` retries and failures

The form is bound to the invoking member. Every signed submission rechecks server,
member, and ownership; owner and Forum cannot be selected through form fields.
Job URLs must be HTTP/S without embedded credentials. The Worker displays them
but never fetches them. All posted messages suppress user/role/everyone mentions.

The opening command's interaction ID is the application primary key, so retries
of the same modal share one record. The Worker atomically claims it before posting
to Discord. A duplicate returns the existing post, or explains that processing or
manual checking is still needed; it does not create a second post.

| Outcome | Behavior |
| --- | --- |
| Validation or authorization fails | Private error, no database writes or Discord calls. |
| Initial D1 save fails | No Forum post is attempted; private database error. |
| Forum lookup/tag validation fails, or creation returns a definite 4xx error | Pending record is removed, and the private reply explains what to fix. |
| Creation times out, returns 5xx, or has an unexpected success body | Pending record is kept because a post may exist. Private reply asks you to check the Forum before resubmitting. |
| Post exists but saving its thread ID fails | Pending record is kept; private reply gives the actual post link and a reference for repair. |
| Private confirmation cannot be delivered | The saved record/post is kept; Worker logs the HTTP status and numeric Discord error code, or a fixed timeout/network category. Check the Forum before resubmitting. |

If Discord stays on **thinking**, inspect **Workers & Pages → tracker-bot →
Observability** for `apply: private reply delivery failed`. Expand that event to
see `operation: reply_edit` and its diagnostic fields: `failure: http` includes
`http_status` and `discord_code` (null if no numeric JSON code was returned).
Other categories are `timeout`, `aborted`, or `network_or_runtime`. Logs omit
tokens, webhook URLs, API messages/bodies, and application text. This logging
helps diagnose failed replies; it does not retry or repair them.

Check whether the Forum post exists and inspect the corresponding D1 row before
retrying the original application. To reproduce after deploying diagnostics,
use one clearly labeled, separate test application and submit it only once.

For an uncertain or pending result, do not open another `/apply` form until you
have checked the Forum and database. Reopening creates a new application key.
Use the private reference to inspect the matching row via Cloudflare D1. If the
post exists, confirm it is the matching application in the owner's configured
Forum and link its thread ID to that row. If you have confirmed no post exists,
remove only that pending row before retrying. Do not delete existing Forum posts
as an automatic rollback.

Operator repair SQL (replace placeholders only after checking both systems):

```sql
UPDATE applications
SET discord_thread_id = 'CONFIRMED_THREAD_ID',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'REFERENCE_ID'
  AND owner_discord_id = 'OWNER_DISCORD_ID'
  AND discord_thread_id IS NULL;
```

If `/apply` is missing, refresh Discord and check registration/install permissions.
For a Forum error, check the mapping, channel type, bot permissions, and exact tag
name. For rate limiting, wait before retrying. If Discord shows no confirmation,
inspect the Forum and use `npx wrangler tail` to check generic Worker errors; do
not add request-body or token logging.

## Database and user routing (M4)

`wrangler.jsonc` binds `disc_tracker_db` to the existing **disc-tracker-db**
database. `DISCORD_GUILD_ID` limits commands to your configured server.
`USER_FORUM_MAP` is a JSON object mapping each allowed Discord User ID to their
Forum Channel ID. Both settings are secrets, keeping personal IDs out of this
public repository. Keep every ID as a quoted string.

Add these two settings to your existing, untracked `.dev.vars`, replacing the
placeholders with your actual IDs:

```dotenv
DISCORD_GUILD_ID="YOUR_SERVER_ID"
USER_FORUM_MAP='{"YOUR_DISCORD_USER_ID":"YOUR_FORUM_CHANNEL_ID","FRIEND_DISCORD_USER_ID":"FRIEND_FORUM_CHANNEL_ID"}'
```

Set the same two production settings with these interactive commands:

```powershell
npx wrangler secret put DISCORD_GUILD_ID
npx wrangler secret put USER_FORUM_MAP
```

At the first prompt, paste your server ID. At the second prompt, paste the JSON
object itself, without the `USER_FORUM_MAP=` prefix or enclosing single quotes.
Keep your existing three Discord credentials. Malformed routing JSON and invalid
Forum IDs deny access without querying the database.

These mappings are passive configuration. Saving, testing, and deploying them
does not invite anyone, send a DM, create a Forum post, or make a Discord API
request. The friend can be configured before joining the server. Automated tests
use fictional IDs and synthetic signed interactions; no friend participation is needed.
`/test` displays the configured Forum; it does not yet verify bot permissions in it.
`/apply` contacts Discord and creates a post only when an authorized member submits
an application; merely configuring or deploying the mapping does not do that.

`migrations/0001_create_applications.sql` creates a single `applications` table:

- Application and Discord IDs are text, preserving large Discord snowflakes.
- Company and position are required and cannot be blank. Optional URL, source,
  and notes are nullable; status defaults to `Applied` and accepts the seven
  agreed statuses.
- `discord_thread_id` is nullable while Forum creation is pending, and unique
  once present. Application IDs are also unique.
- `applied_at` stores the application date; creation and update timestamps default
  to UTC ISO strings. Future update code must explicitly refresh `updated_at`.
- An owner/update-time index supports future owner-scoped queries. Application
  reads and updates in later commands must include the authorized owner ID.

Apply migrations separately from deployment. From the project folder after merging:

```powershell
git switch master
git pull --ff-only origin master
npm ci
npm test -- --run
npm run test:scripts
npx tsc --noEmit
npx tsc --noEmit -p test/tsconfig.json
npx wrangler d1 migrations apply disc-tracker-db --remote
npm run deploy
```

Confirm Wrangler's migration prompt for **disc-tracker-db**. The migration runner
records applied files in `d1_migrations`, so subsequent runs skip completed files.
Deployment alone does not create the table. Keep existing production secrets and
the saved Interactions Endpoint URL. `/test` is already registered; no command
registration is needed for M4.

Run `/test` in Discord as yourself. Expect a private reply:

```text
Job Tracker is connected!
Database is ready. Your Forum: #applications-rafli.
```

The Forum name renders from the configured channel ID. If it is wrong, correct
`USER_FORUM_MAP` using `wrangler secret put USER_FORUM_MAP` (and update `.dev.vars`
for local development). If the bot says the database is
not ready, check the D1 binding and apply the remote migration. Once the reply
shows database readiness and your Forum, M4's live check is complete.

For local development, initialize a separate local database first:

```powershell
npx wrangler d1 migrations apply disc-tracker-db --local
npm run dev
```

Local migrations and automated tests do not change the remote database.

## Run and verify locally (PowerShell)

After merging the PR, open a terminal in your existing project folder:

```powershell
git switch master
git pull --ff-only origin master
npm ci
npm run cf-typegen
npx tsc --noEmit
npx tsc --noEmit -p test/tsconfig.json
npm test -- --run
npm run test:scripts
```

If Git reports uncommitted changes, keep your local edits and resolve them before
switching branches or pulling; do not discard them to run these commands.

Keep your existing `.dev.vars` next to `wrangler.jsonc`, with these names:

```dotenv
DISCORD_APPLICATION_ID="your-application-id"
DISCORD_PUBLIC_KEY="your-application-public-key"
DISCORD_TOKEN="your-bot-token"
```

Do not commit this file or share its values. `wrangler.jsonc` contains required
secret names only; `npm run cf-typegen` generates `Env` without needing values.
Tests generate their own temporary signing key and override all five secrets,
so the suite can run without `.dev.vars` or production credentials.

Start the local Worker:

```powershell
npm run dev
```

In a second terminal:

```powershell
curl.exe -i http://localhost:8787/
curl.exe -i -X POST http://localhost:8787/ --data-binary '{}'
```

The GET should return HTTP 200 and `Job Tracker is running!`. The unsigned POST
should return HTTP 401. The automated tests cover correctly signed PING requests,
invalid signatures, altered bodies/timestamps, and payload validation.

## Deploy and register with Discord

1. Stop the local server with Ctrl+C.
2. Verify your existing production secret names with `npx wrangler secret list`.
   The configured Worker name is **`tracker-bot`**. Make sure the secrets were set
   on this Worker, especially if you previously used another project/Worker name.
3. Deploy from this project folder:

   ```powershell
   npm run deploy
   ```

   If Wrangler reports a missing required secret, set only the missing one locally
   with `npx wrangler secret put SECRET_NAME`, entering its value at the prompt,
   then deploy again. Do not replace existing secrets unnecessarily.
4. Open the HTTPS `workers.dev` URL printed by Wrangler and confirm the health
   check text. The Interactions Endpoint uses this same root URL, with no extra
   `/interactions` suffix.
5. Open [Discord Developer Portal](https://discord.com/developers/applications),
   select your application, and go to **General Information**.
6. Set **Interactions Endpoint URL** to that Worker URL and save. Discord sends a
   signed PING and validates signature rejection before accepting the endpoint.
7. Confirm the URL saves successfully, then register `/test` below. If the existing
   endpoint URL is already saved successfully, keep it; deploy the updated Worker
   before running `/test`.

If Discord rejects the URL, check that `DISCORD_PUBLIC_KEY` matches this Discord
application's Public Key (not its Bot Token or Application ID). Also confirm you
used the URL printed by the deployment. `npx wrangler tail` can help observe the
request status; do not add logging of request bodies, interaction tokens, or secrets.

## Register and run `/test` (M3.4)

Use Node.js 22 or newer and run the script from your project folder. It reads
`DISCORD_APPLICATION_ID` and `DISCORD_TOKEN` from the existing local `.dev.vars`
(or environment variables). Cloudflare production secrets are not downloaded.

1. In Discord, open **User Settings → Advanced** and enable **Developer Mode**.
2. Right-click your private server's icon and choose **Copy Server ID**. This is
   the server ID, not the command channel ID or application ID.
3. After deploying this Worker version, run:

   ```powershell
   npm run register:test -- YOUR_SERVER_ID
   ```

   Replace `YOUR_SERVER_ID` with the copied number. The script creates/updates
   only this guild's `/test` command; it preserves other commands and does not
   register a global command. It does not print credentials or API response bodies.
4. In your bot command channel, select this app's `/test` from the slash command
   menu and send it. Expect **Job Tracker is connected!**, visible only to you.
5. Once that succeeds, M3 is complete. Follow the M4 migration steps above.

If registration returns HTTP 401, check the local Bot Token and Application ID.
For HTTP 403/404, check the server ID and the app's installation in that server.
For HTTP 429, wait before retrying. If `/test` is missing, refresh Discord and check
the app's command permissions. If Discord says the application did not respond,
confirm this Worker version was deployed and inspect statuses with `npx wrangler tail`.

## Official references

- [Wrangler required secrets and generated types](https://developers.cloudflare.com/workers/wrangler/configuration/#secrets-configuration-property)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Discord Interactions endpoint validation](https://docs.discord.com/developers/interactions/overview)
- [Discord guild application commands](https://docs.discord.com/developers/interactions/application-commands)
- [Finding Discord server IDs](https://support.discord.com/hc/en-us/articles/206346498)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Workers tests with D1 migrations](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/#d1)
- [Discord modal components](https://docs.discord.com/developers/components/using-modal-components)
- [Discord Forum posts and tags](https://docs.discord.com/developers/resources/channel#start-thread-in-forum-or-media-channel)
