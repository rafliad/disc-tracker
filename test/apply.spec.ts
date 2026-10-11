import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { ownerId, friendId, guildId, signedRequest } from './helpers';

const applicationId = '777777777777777777';
const commandId = '888888888888888888';
const threadId = '666666666666666666';
const tagId = '121212121212121212';
const ownerForum = '333333333333333333';
const friendForum = '444444444444444444';
const token = 'fixture-interaction-token';

function command(userId = ownerId) {
	return { type: 2, id: commandId, application_id: applicationId, guild_id: guildId,
		member: { user: { id: userId } }, data: { type: 1, name: 'apply' } };
}
function submission(userId = ownerId, values: Partial<Record<'company' | 'position' | 'job_url' | 'notes', string>> = {}) {
	return { ...command(userId), type: 5, id: '999999999999999999', token,
		data: { custom_id: `apply:${commandId}:${userId}`, components:
			Object.entries({ company: ' Example Company ', position: ' Software Engineer ',
				job_url: 'https://example.com/jobs/1', notes: 'Sent CV', ...values })
				.map(([custom_id, value]) => ({ type: 18, component: { type: 4, custom_id, value } })),
		} };
}

type Call = { url: string; method: string; body: any; authorization: string | null; redirect: string };
function mockDiscord(options: { missingTag?: boolean; wrongGuild?: boolean; channelStatus?: number;
	postStatus?: number; postThrows?: boolean; invalidThread?: boolean; replyStatus?: number;
	replyBody?: unknown; replyHtml?: boolean; replyError?: Error; gate?: Promise<void> } = {}) {
	const calls: Call[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		// Exercise workerd's real Request validation before replacing network I/O.
		const request = new Request(String(input), init);
		const url = String(input);
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		calls.push({ url, method, body, authorization: new Headers(init?.headers).get('Authorization'), redirect: request.redirect });
		if (method === 'GET') {
			await options.gate;
			const id = url.split('/').at(-1);
			return Response.json({ id, type: 15, guild_id: options.wrongGuild ? '123456789012345678' : guildId,
				available_tags: options.missingTag ? [] : [{ id: tagId, name: 'Applied' }] },
				{ status: options.channelStatus ?? 200 });
		}
		if (method === 'POST') {
			if (options.postThrows) throw new Error('sensitive network detail ' + token);
			return Response.json(options.invalidThread ? {} : { id: threadId }, { status: options.postStatus ?? 201 });
		}
		if (options.replyError) throw options.replyError;
		if (options.replyHtml) return new Response('sensitive proxy body ' + token, { status: options.replyStatus ?? 403 });
		return Response.json(options.replyBody ?? { id: '101010101010101010' }, { status: options.replyStatus ?? 200 });
	});
	return calls;
}
async function run(payload: unknown, bindings: Env = env) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(await signedRequest(JSON.stringify(payload)), bindings, ctx);
	const reply = await response.json<any>();
	await waitOnExecutionContext(ctx);
	return { response, reply };
}
async function count() {
	return env.disc_tracker_db.prepare('SELECT COUNT(*) AS count FROM applications').first('count');
}
afterEach(() => vi.restoreAllMocks());

describe('/apply', () => {
	it('saves and confirms using options accepted by the real Workers Request constructor', async () => {
		const calls = mockDiscord();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		await run(submission());
		expect(await env.disc_tracker_db.prepare('SELECT discord_thread_id FROM applications').first('discord_thread_id')).toBe(threadId);
		expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'PATCH']);
		expect(calls.every((call) => call.redirect === 'manual')).toBe(true);
		expect(calls.at(-1)?.body.content).toContain('Application saved — Applied');
		expect(log).not.toHaveBeenCalled();
	});

	it('rejects a Forum lookup redirect without creating a post or retaining the claim', async () => {
		const calls = mockDiscord({ channelStatus: 302 });
		await run(submission());
		expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH']);
		expect(calls.every((call) => call.redirect === 'manual')).toBe(true);
		expect(calls.at(-1)?.body.content).toContain('HTTP 302');
		expect(await count()).toBe(0);
	});

	it('retains an uncertain creation redirect and never reposts a duplicate submission', async () => {
		const calls = mockDiscord({ postStatus: 307 });
		await run(submission());
		expect(await count()).toBe(1);
		expect(calls.at(-1)?.body.content).toContain('Do not submit again');
		await run(submission());
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
		expect(calls.every((call) => call.redirect === 'manual')).toBe(true);
	});

	it('logs a confirmation redirect while preserving the saved post', async () => {
		const calls = mockDiscord({ replyStatus: 308 });
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		await run(submission());
		expect(await env.disc_tracker_db.prepare('SELECT discord_thread_id FROM applications').first('discord_thread_id')).toBe(threadId);
		expect(calls.every((call) => call.redirect === 'manual')).toBe(true);
		expect(log).toHaveBeenCalledWith(expect.any(String), { operation: 'reply_edit', failure: 'http', http_status: 308, discord_code: null });
	});

	it('opens the four-field modal for an authorized guild member without doing background work', async () => {
		const calls = mockDiscord();
		const response = await SELF.fetch(await signedRequest(JSON.stringify(command())));
		expect(response.status).toBe(200);
		const modal = await response.json<any>();
		expect(modal.type).toBe(9);
		expect(modal.data.custom_id).toBe(`apply:${commandId}:${ownerId}`);
		expect(modal.data.title).toBe('Track a job application');
		expect(modal.data.components.map((label: any) => [label.type, label.component.type, label.component.custom_id, label.component.required]))
			.toEqual([[18, 4, 'company', true], [18, 4, 'position', true], [18, 4, 'job_url', false], [18, 4, 'notes', false]]);
		expect(calls).toHaveLength(0);
		expect(await count()).toBe(0);
	});

	it.each([
		{ userId: ownerId, forumId: ownerForum }, { userId: friendId, forumId: friendForum },
	])('defers privately, saves to D1, and posts only to $userId\'s Forum', async ({ userId, forumId }) => {
		const calls = mockDiscord();
		const { reply } = await run(submission(userId));
		expect(reply).toEqual({ type: 5, data: { flags: 64 } });
		const row = await env.disc_tracker_db.prepare('SELECT * FROM applications').first();
		expect(row).toMatchObject({ id: commandId, owner_discord_id: userId, forum_channel_id: forumId,
			discord_thread_id: threadId, company: 'Example Company', position: 'Software Engineer',
			job_url: 'https://example.com/jobs/1', notes: 'Sent CV', status: 'Applied' });
		const expectedDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
		expect(row?.applied_at).toBe(expectedDate);
		const post = calls.find((call) => call.method === 'POST')!;
		expect(post.url).toBe(`https://discord.com/api/v10/channels/${forumId}/threads`);
		expect(post.authorization).toBe('Bot test-token');
		expect(post.body.applied_tags).toEqual([tagId]);
		expect(post.body.message.allowed_mentions).toEqual({ parse: [] });
		expect(calls.at(-1)?.url).toBe(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`);
		expect(calls.at(-1)?.authorization).toBeNull();
		expect(calls.at(-1)?.body.content).toContain(`https://discord.com/channels/${guildId}/${threadId}`);
		expect(calls.at(-1)?.body.content).toContain('Applied');
	});

	it('accepts omitted optional values without fetching the submitted job URL', async () => {
		const calls = mockDiscord();
		await run(submission(ownerId, { job_url: '', notes: '' }));
		expect(await env.disc_tracker_db.prepare('SELECT job_url, notes FROM applications').first()).toEqual({ job_url: null, notes: null });
		expect(calls.every((call) => call.url.startsWith('https://discord.com/api/v10/'))).toBe(true);
	});

	it('returns the private deferral before Discord REST work finishes', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		mockDiscord({ gate });
		const ctx = createExecutionContext();
		try {
			const response = await worker.fetch(await signedRequest(JSON.stringify(submission())), env, ctx);
			expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
		} finally {
			release();
			await waitOnExecutionContext(ctx);
		}
	});

	it.each([
		{ label: 'missing token', payload: { ...submission(), token: undefined } },
		{ label: 'wrong application ID', payload: { ...submission(), application_id: '123456789012345678' } },
		{ label: 'numeric interaction ID', payload: { ...submission(), id: 123 } },
		{ label: 'duplicate form field', payload: { ...submission(), data: { ...submission().data,
			components: [submission().data.components[0], submission().data.components[0]] } } },
		{ label: 'non-text component', payload: { ...submission(), data: { ...submission().data,
			components: [{ type: 18, component: { type: 3, custom_id: 'company', value: 'Test' } }] } } },
	])('rejects malformed submission ($label) without background work', async ({ payload }) => {
		const calls = mockDiscord();
		const { reply } = await run(payload);
		expect(reply.type).toBe(4);
		expect(reply.data.flags).toBe(64);
		expect(calls).toHaveLength(0);
		expect(await count()).toBe(0);
	});

	it('rejects an unsigned modal submission before parsing or external calls', async () => {
		const calls = mockDiscord();
		const response = await SELF.fetch('https://example.com/', { method: 'POST', body: JSON.stringify(submission()) });
		expect(response.status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	it.each([
		{ label: 'unknown user command', payload: command('123456789012345678') },
		{ label: 'unknown user submission', payload: submission('123456789012345678') },
		{ label: 'wrong server', payload: { ...submission(), guild_id: '123456789012345678' } },
		{ label: 'another owner\'s modal', payload: { ...submission(friendId), data: submission(ownerId).data } },
	])('rejects $label without D1 writes or Discord calls', async ({ payload }) => {
		const calls = mockDiscord();
		const { reply } = await run(payload);
		expect(reply.type).toBe(4);
		expect(reply.data.flags).toBe(64);
		expect(calls).toHaveLength(0);
		expect(await count()).toBe(0);
	});

	it.each([
		{ label: 'blank company', values: { company: '   ' } },
		{ label: 'blank position', values: { position: '' } },
		{ label: 'long company', values: { company: 'x'.repeat(101) } },
		{ label: 'multiline position', values: { position: 'One\nTwo' } },
		{ label: 'invalid URL', values: { job_url: 'not a URL' } },
		{ label: 'javascript URL', values: { job_url: 'javascript:alert(1)' } },
		{ label: 'credentials in URL', values: { job_url: 'https://user:password@example.com' } },
		{ label: 'long URL', values: { job_url: 'https://example.com/' + 'x'.repeat(1000) } },
		{ label: 'long notes', values: { notes: 'x'.repeat(2001) } },
	])('rejects $label privately before any writes', async ({ values }) => {
		const calls = mockDiscord();
		const { reply } = await run(submission(ownerId, values));
		expect(reply.type).toBe(4);
		expect(reply.data.flags).toBe(64);
		expect(calls).toHaveLength(0);
		expect(await count()).toBe(0);
	});

	it('uses one record and one post for concurrent retries of the same modal', async () => {
		const calls = mockDiscord();
		await Promise.all([run(submission()), run(submission())]);
		expect(await count()).toBe(1);
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
	});

	it('returns the existing post for a later duplicate submission', async () => {
		const calls = mockDiscord();
		await run(submission());
		await run(submission());
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
		expect(calls.at(-1)?.body.content).toContain('already');
		expect(calls.at(-1)?.body.content).toContain(threadId);
	});

	it.each([
		{ label: 'missing Applied tag', options: { missingTag: true } },
		{ label: 'wrong Forum guild', options: { wrongGuild: true } },
		{ label: 'inaccessible Forum', options: { channelStatus: 403 } },
		{ label: 'creation forbidden', options: { postStatus: 403 } },
		{ label: 'rate limited', options: { postStatus: 429 } },
	])('cleans up the pending record after a definite failure ($label)', async ({ options }) => {
		const calls = mockDiscord(options);
		await run(submission());
		expect(await count()).toBe(0);
		expect(calls.at(-1)?.body.content).not.toContain('Application saved');
	});

	it.each([
		{ label: 'network timeout', options: { postThrows: true } },
		{ label: 'server error', options: { postStatus: 500 } },
		{ label: 'unexpected success body', options: { invalidThread: true } },
	])('keeps a pending record and avoids reposting after an uncertain outcome ($label)', async ({ options }) => {
		const calls = mockDiscord(options);
		await run(submission());
		expect(await env.disc_tracker_db.prepare('SELECT discord_thread_id FROM applications').first('discord_thread_id')).toBeNull();
		expect(await count()).toBe(1);
		expect(calls.at(-1)?.body.content).toContain('Do not submit again');
		await run(submission());
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
	});

	it('does not create a post if the initial database write fails', async () => {
		const calls = mockDiscord();
		const bindings = { ...env, disc_tracker_db: { prepare: () => { throw new Error('DB unavailable'); } } as unknown as D1Database };
		await run(submission(), bindings);
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
		expect(calls.at(-1)?.body.content).toContain('Database');
	});

	it('reports the actual post link if linking it back to D1 fails, without creating a second post', async () => {
		const calls = mockDiscord();
		const bindings = { ...env, disc_tracker_db: { prepare: (query: string) => {
			if (query.includes('UPDATE applications SET discord_thread_id')) throw new Error('DB linking failed');
			return env.disc_tracker_db.prepare(query);
		} } as unknown as D1Database };
		await run(submission(), bindings);
		expect(calls.at(-1)?.body.content).toContain('database link');
		expect(calls.at(-1)?.body.content).toContain(threadId);
		expect(calls.at(-1)?.body.content).not.toContain('Application saved');
		await run(submission(), bindings);
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
	});

	it('bounds long Unicode titles and suppresses mentions in post and confirmation', async () => {
		const calls = mockDiscord();
		await run(submission(ownerId, { company: '💼'.repeat(50), position: '@everyone', notes: '@here <@123456789012345678>' }));
		const post = calls.find((call) => call.method === 'POST')!;
		expect(post.body.name.length).toBeLessThanOrEqual(100);
		expect(post.body.name).not.toMatch(/[\uD800-\uDBFF]$/);
		expect(post.body.message.allowed_mentions).toEqual({ parse: [] });
		expect(calls.at(-1)?.body.allowed_mentions).toEqual({ parse: [] });
	});

	it('preserves a successfully saved post when confirmation delivery fails without leaking tokens', async () => {
		const calls = mockDiscord({ replyStatus: 500 });
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		await run(submission());
		expect(await env.disc_tracker_db.prepare('SELECT discord_thread_id FROM applications').first('discord_thread_id')).toBe(threadId);
		expect(log).toHaveBeenCalledOnce();
		expect(JSON.stringify(log.mock.calls)).not.toContain(token);
		await run(submission());
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
	});

	it.each([
		{ status: 404, code: 10015 }, { status: 401, code: 50027 }, { status: 429, code: 20028 },
	])('records the HTTP $status and numeric Discord error code for a failed private reply', async ({ status, code }) => {
		mockDiscord({ replyStatus: status, replyBody: { code, message: `sensitive ${token}`, content: 'Example Company' } });
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		await run(submission());
		expect(log).toHaveBeenCalledExactlyOnceWith(
			'apply: private reply delivery failed; check the Forum and database before resubmitting.',
			{ operation: 'reply_edit', failure: 'http', http_status: status, discord_code: code },
		);
		expect(JSON.stringify(log.mock.calls)).not.toMatch(/fixture-interaction-token|Example Company|webhooks|sensitive/);
		expect(await env.disc_tracker_db.prepare('SELECT discord_thread_id FROM applications').first('discord_thread_id')).toBe(threadId);
	});

	it.each([
		{ label: 'HTML error response', options: { replyStatus: 403, replyHtml: true } },
		{ label: 'untrusted code string', options: { replyStatus: 403, replyBody: { code: token, message: token } } },
	])('records the HTTP status without leaking an $label', async ({ options }) => {
		mockDiscord(options);
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		await run(submission());
		expect(log).toHaveBeenCalledExactlyOnceWith(
			'apply: private reply delivery failed; check the Forum and database before resubmitting.',
			{ operation: 'reply_edit', failure: 'http', http_status: 403, discord_code: null },
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain(token);
	});

	it.each([
		{ name: 'TimeoutError', failure: 'timeout' }, { name: 'AbortError', failure: 'aborted' },
		{ name: 'TypeError', failure: 'network_or_runtime' }, { name: token, failure: 'network_or_runtime' },
	])('safely classifies a private reply exception ($failure)', async ({ name, failure }) => {
		const error = new Error(`sensitive URL /webhooks/${token}`);
		error.name = name;
		mockDiscord({ replyError: error });
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		await run(submission());
		expect(log).toHaveBeenCalledExactlyOnceWith(
			'apply: private reply delivery failed; check the Forum and database before resubmitting.',
			{ operation: 'reply_edit', failure },
		);
		expect(JSON.stringify(log.mock.calls)).not.toMatch(/fixture-interaction-token|webhooks|sensitive/);
		expect(await count()).toBe(1);
	});

	it('reports a retained pending record when cleanup fails', async () => {
		const calls = mockDiscord({ missingTag: true });
		const bindings = { ...env, disc_tracker_db: { prepare: (query: string) => {
			if (query.startsWith('DELETE FROM applications')) throw new Error('Cleanup failed');
			return env.disc_tracker_db.prepare(query);
		} } as unknown as D1Database };
		await run(submission(), bindings);
		expect(await count()).toBe(1);
		expect(calls.at(-1)?.body.content).toContain('pending record needs checking');
		expect(calls.at(-1)?.body.content).toContain('Do not submit again');
	});
});
