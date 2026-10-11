import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

function fail(message) {
	console.error(message);
	process.exitCode = 1;
}

async function main() {
	const [guildId, ...extraArgs] = process.argv.slice(2);
	const isDiscordId = (value) => typeof value === 'string' && /^[1-9]\d{16,19}$/.test(value);
	if (!isDiscordId(guildId) || extraArgs.length) {
		return fail('Usage: npm run register:test -- YOUR_SERVER_ID (copy the numeric server ID from Discord).');
	}

	// Run from the project folder. Existing environment variables take precedence.
	if (existsSync('.dev.vars')) {
		loadEnvFile('.dev.vars');
	}
	const applicationId = process.env.DISCORD_APPLICATION_ID;
	const token = process.env.DISCORD_TOKEN;
	if (!isDiscordId(applicationId) || !token?.trim()) {
		return fail('Set a valid DISCORD_APPLICATION_ID and DISCORD_TOKEN in .dev.vars or your local environment.');
	}

	let response;
	try {
		response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`, {
			method: 'POST',
			headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 1, name: 'test', description: 'Check that Job Tracker is connected.' }),
			redirect: 'error',
			signal: AbortSignal.timeout(10000),
		});
	} catch {
		return fail('Could not reach Discord. Check your connection and try again.');
	}
	if (!response.ok) {
		const advice = response.status === 401
			? 'Check the local Bot Token and Application ID.'
			: response.status === 429
				? 'Wait a moment before trying again.'
				: 'Check the server ID, Application ID, and that the app is installed in this server.';
		return fail(`Discord rejected registration (HTTP ${response.status}). ${advice}`);
	}

	// POST upserts only this command; it does not replace the server's command list.
	console.log(`Registered /test in server ${guildId}.`);
}

main().catch(() => fail('Could not load local configuration. Check your .dev.vars file and Node.js version.'));
