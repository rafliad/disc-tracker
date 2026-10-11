# Discord Job Application Tracker

A private Discord job application tracker for two users. The intended MVP uses
`/apply`, `/status`, separate Discord Forum Channels, and Cloudflare D1.

## Current milestone: M3.4

This change implements the Discord Interactions endpoint at the Worker's root URL:

- `GET /`: returns `Job Tracker is running!` as a health check.
- `POST /`: verifies Discord's Ed25519 signature against the timestamp and exact
  request body before parsing JSON. Unsigned or invalid signatures return HTTP 401.
- A correctly signed PING (`type: 1`) returns HTTP 200 and JSON `{ "type": 1 }`.
- A correctly signed guild `/test` interaction replies `Job Tracker is connected!`
  ephemerally (only the person who ran the command sees it).
- Signed malformed payloads and interaction types not implemented yet return 400.
- A missing or malformed configured public key returns 500 for a signed request.
- Other paths return 404; unsupported methods at `/` return 405.

D1, user-to-Forum routing, `/apply`, and `/status` come in later milestones.
M3.3 endpoint registration has been confirmed by the project owner. M3.4 still
requires deploying this version, registering `/test`, and running it in Discord.

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
Tests generate their own temporary signing key and override all three bindings,
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
5. Once that succeeds, M3 is complete. Continue to M4: D1 and user-to-Forum routing.

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
