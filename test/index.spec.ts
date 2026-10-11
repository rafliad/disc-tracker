import { env, createExecutionContext, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import worker from '../src/index';

declare module 'vitest' {
	interface ProvidedContext {
		signingKeyPkcs8: string;
	}
}

const endpoint = 'https://example.com/';
const pingBody = '{"type":1}';
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
let signingKey: CryptoKey;

beforeAll(async () => {
	const privateKey = Uint8Array.from(atob(inject('signingKeyPkcs8')), (character) => character.charCodeAt(0));
	signingKey = await crypto.subtle.importKey('pkcs8', privateKey, 'Ed25519', false, ['sign']);
});

async function signedRequest(body = pingBody): Promise<Request<unknown, IncomingRequestCfProperties>> {
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

describe('Discord interactions endpoint', () => {
	it('provides a public GET health check', async () => {
		const response = await SELF.fetch(endpoint);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('Job Tracker is running!');
	});

	it('returns PONG for a correctly signed PING', async () => {
		const response = await SELF.fetch(await signedRequest());
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		expect(await response.json()).toEqual({ type: 1 });
	});

	it('verifies the original body including whitespace and Unicode', async () => {
		const response = await SELF.fetch(await signedRequest(' {\n "type": 1, "note": "lamaran café 💼"\n } '));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 1 });
	});

	it('rejects an unsigned POST', async () => {
		const response = await SELF.fetch(endpoint, { method: 'POST', body: pingBody });
		expect(response.status).toBe(401);
	});

	it.each(['X-Signature-Ed25519', 'X-Signature-Timestamp'])('rejects a missing %s header', async (header) => {
		const request = await signedRequest();
		request.headers.delete(header);
		expect((await SELF.fetch(request)).status).toBe(401);
	});

	it.each([
		{ label: 'empty', signature: '' },
		{ label: 'too short', signature: '00' },
		{ label: 'non-hexadecimal', signature: 'gg'.repeat(64) },
		{ label: 'too long', signature: '00'.repeat(65) },
		{ label: 'incorrect but correctly sized', signature: '00'.repeat(64) },
	])('rejects an invalid signature ($label)', async ({ signature }) => {
		const request = await signedRequest();
		request.headers.set('X-Signature-Ed25519', signature);
		expect((await SELF.fetch(request)).status).toBe(401);
	});

	it('rejects a changed request body', async () => {
		const request = await signedRequest();
		const response = await SELF.fetch(new Request(endpoint, {
			method: 'POST', headers: request.headers, body: '{"type":2}',
		}));
		expect(response.status).toBe(401);
	});

	it('rejects a changed timestamp', async () => {
		const request = await signedRequest();
		request.headers.set('X-Signature-Timestamp', '123');
		expect((await SELF.fetch(request)).status).toBe(401);
	});

	it('checks the signature before trying to parse JSON', async () => {
		const response = await SELF.fetch(endpoint, { method: 'POST', body: 'not JSON' });
		expect(response.status).toBe(401);
	});

	it('returns 400 for correctly signed invalid JSON', async () => {
		expect((await SELF.fetch(await signedRequest('not JSON'))).status).toBe(400);
	});

	it.each(['null', '[]', '"hello"', '1', '{}', '{"type":"1"}'])('rejects an invalid interaction payload (%s)', async (body) => {
		expect((await SELF.fetch(await signedRequest(body))).status).toBe(400);
	});

	it('does not pretend to handle commands before M3.4', async () => {
		expect((await SELF.fetch(await signedRequest('{"type":2}'))).status).toBe(400);
	});

	it.each(['', 'invalid-public-key'])('returns a server error for a misconfigured public key (%s)', async (publicKey) => {
		const response = await worker.fetch(await signedRequest(), { ...env, DISCORD_PUBLIC_KEY: publicKey }, createExecutionContext());
		expect(response.status).toBe(500);
	});

	it('returns 404 for an unknown path', async () => {
		expect((await SELF.fetch('https://example.com/missing')).status).toBe(404);
	});

	it('returns 405 for unsupported HTTP methods', async () => {
		const response = await SELF.fetch(endpoint, { method: 'PUT' });
		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('GET, POST');
	});
});
