# Discord Job Application Tracker

A private Discord job application tracker for two users. The intended MVP uses
`/apply`, `/status`, separate Discord Forum Channels, and Cloudflare D1.

## Current milestone: M4

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
- Signed malformed payloads and interaction types not implemented yet return 400.
- A missing or malformed configured public key returns 500 for a signed request.
- Other paths return 404; unsupported methods at `/` return 405.

M3 endpoint registration and the live `/test` reply have been confirmed by the
project owner. M4 adds D1, the application schema, and per-user Forum routing.
`/apply` and `/status` come in later milestones.

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
