import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { generateKeyPairSync } from "node:crypto";

// A fresh test-only key pair; these tests never need Discord credentials.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const testBindings = {
	DISCORD_APPLICATION_ID: "test-application",
	DISCORD_PUBLIC_KEY: publicKeyHex,
	DISCORD_TOKEN: "test-token",
	DISCORD_GUILD_ID: "555555555555555555",
	USER_FORUM_MAP: JSON.stringify({
		"111111111111111111": "333333333333333333",
		"222222222222222222": "444444444444444444",
	}),
};
// Wrangler validates required names before Miniflare applies its overrides.
// These values exist only in this test process, never in production configuration.
Object.assign(process.env, testBindings);

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: testBindings,
			},
		}),
	],
	test: {
		setupFiles: ["./test/setup.ts"],
		provide: {
			migrations: await readD1Migrations("./migrations"),
			signingKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
		},
	},
});
