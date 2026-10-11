# Discord Job Application Tracker

A private Discord job application tracker for two users. The intended MVP uses
`/apply`, `/status`, separate Discord Forum Channels, and Cloudflare D1.

## Current milestone: M3.3

This change implements the Discord Interactions endpoint at the Worker's root URL:

- `GET /`: returns `Job Tracker is running!` as a health check.
- `POST /`: verifies Discord's Ed25519 signature against the timestamp and exact
  request body before parsing JSON. Unsigned or invalid signatures return HTTP 401.
- A correctly signed PING (`type: 1`) returns HTTP 200 and JSON `{ "type": 1 }`.
- Signed malformed payloads and interaction types not implemented yet return 400.
- A missing or malformed configured public key returns 500 for a signed request.
- Other paths return 404; unsupported methods at `/` return 405.

Slash command handling, D1, and Forum updates come in later milestones. M3.3 is
verified in production only after Discord accepts the deployed endpoint.

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
7. Confirm the URL saves successfully. Only then proceed to M3.4: `/test`.

If Discord rejects the URL, check that `DISCORD_PUBLIC_KEY` matches this Discord
application's Public Key (not its Bot Token or Application ID). Also confirm you
used the URL printed by the deployment. `npx wrangler tail` can help observe the
request status; do not add logging of request bodies, interaction tokens, or secrets.

## Official references

- [Wrangler required secrets and generated types](https://developers.cloudflare.com/workers/wrangler/configuration/#secrets-configuration-property)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Discord Interactions endpoint validation](https://docs.discord.com/developers/interactions/overview)
