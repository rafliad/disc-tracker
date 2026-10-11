import { beforeAll, inject } from 'vitest';

declare module 'vitest' {
	interface ProvidedContext {
		signingKeyPkcs8: string;
	}
}

export const endpoint = 'https://example.com/';
export const pingBody = '{"type":1}';
export const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
export const ownerId = '111111111111111111';
export const friendId = '222222222222222222';
export const guildId = '555555555555555555';
export function testCommand(userId = ownerId, serverId = guildId) {
	return { type: 2, guild_id: serverId, member: { user: { id: userId } }, data: { type: 1, name: 'test' } };
}
let signingKey: CryptoKey;

beforeAll(async () => {
	const privateKey = Uint8Array.from(atob(inject('signingKeyPkcs8')), (character) => character.charCodeAt(0));
	signingKey = await crypto.subtle.importKey('pkcs8', privateKey, 'Ed25519', false, ['sign']);
});

export async function signedRequest(body = pingBody): Promise<Request<unknown, IncomingRequestCfProperties>> {
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = await crypto.subtle.sign('Ed25519', signingKey, new TextEncoder().encode(timestamp + body));
	const signatureHex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
	return new IncomingRequest(endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Signature-Ed25519': signatureHex,
			'X-Signature-Timestamp': timestamp,
		},
		body,
	});
}

