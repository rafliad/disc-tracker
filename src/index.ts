import { resolveUserForum } from './authorization';

/** Decode fixed-size hexadecimal keys/signatures without accepting partial values. */
function decodeHex(value: string | null | undefined, byteLength: number): Uint8Array<ArrayBuffer> | null {
	if (!value || value.length !== byteLength * 2 || !/^[0-9a-f]+$/i.test(value)) {
		return null;
	}

	const bytes = new Uint8Array(byteLength);
	for (let index = 0; index < byteLength; index++) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		if (new URL(request.url).pathname !== '/') {
			return new Response('Not found', { status: 404 });
		}
		if (request.method === 'GET') {
			return new Response('Job Tracker is running!');
		}
		if (request.method !== 'POST') {
			return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
		}

		const signature = decodeHex(request.headers.get('X-Signature-Ed25519'), 64);
		const timestamp = request.headers.get('X-Signature-Timestamp');
		if (!signature || !timestamp) {
			return new Response('Invalid request signature', { status: 401 });
		}

		const publicKeyBytes = decodeHex(env.DISCORD_PUBLIC_KEY, 32);
		if (!publicKeyBytes) {
			return new Response('Discord public key is not configured correctly', { status: 500 });
		}

		// Discord signs the timestamp followed by the original body bytes.
		// Verify these bytes before parsing JSON or otherwise changing the body.
		const rawBody = await request.arrayBuffer();
		const timestampBytes = new TextEncoder().encode(timestamp);
		const signedMessage = new Uint8Array(timestampBytes.length + rawBody.byteLength);
		signedMessage.set(timestampBytes);
		signedMessage.set(new Uint8Array(rawBody), timestampBytes.length);

		try {
			const publicKey = await crypto.subtle.importKey('raw', publicKeyBytes, 'Ed25519', false, ['verify']);
			const verified = await crypto.subtle.verify('Ed25519', publicKey, signature, signedMessage);
			if (!verified) {
				return new Response('Invalid request signature', { status: 401 });
			}
		} catch {
			// Do not include request payloads, interaction tokens, or credentials in logs.
			return new Response('Unable to verify the Discord request', { status: 500 });
		}

		let interaction: unknown;
		try {
			interaction = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(rawBody));
		} catch {
			return new Response('Invalid JSON', { status: 400 });
		}

		if (typeof interaction !== 'object' || interaction === null || !('type' in interaction) || typeof interaction.type !== 'number') {
			return new Response('Invalid interaction payload', { status: 400 });
		}
		if (interaction.type === 1) {
			return Response.json({ type: 1 });
		}
		if (interaction.type === 2 && 'guild_id' in interaction && typeof interaction.guild_id === 'string' && interaction.guild_id) {
			const command = 'data' in interaction ? interaction.data : null;
			if (
				typeof command === 'object' && command !== null &&
				'type' in command && command.type === 1 &&
				'name' in command && command.name === 'test'
			) {
				const userForum = resolveUserForum(interaction, env);
				if (!userForum) {
					return Response.json({
						type: 4,
						data: { content: 'You do not have access to this tracker in this server.', flags: 64 },
					});
				}
				try {
					// Check the binding and migrated table without reading application data.
					await env.disc_tracker_db.prepare('SELECT id FROM applications LIMIT 0').all();
				} catch {
					return Response.json({
						type: 4,
						data: { content: 'Database is not ready. Apply the D1 migration, then try /test again.', flags: 64 },
					});
				}
				return Response.json({
					type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
					data: {
						content: `Job Tracker is connected!\nDatabase is ready. Your Forum: <#${userForum.forumChannelId}>.`,
						flags: 64, // EPHEMERAL
					},
				});
			}
		}

		// Application tracking commands are added after the M4 database/routing milestone.
		return new Response('Unsupported interaction type', { status: 400 });
	},
} satisfies ExportedHandler<Env>;
