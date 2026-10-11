import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { ownerId, friendId, guildId, signedRequest } from './helpers';

const applicationId = '888888888888888888';
const interactionId = '999999999999999999';
const threadId = '666666666666666666';
const ownerForum = '333333333333333333';
const friendForum = '444444444444444444';
const token = 'status-fixture-token';
const statuses = ['Applied', 'Screening', 'Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn'];
const tagId = (index: number) => `13131313131313131${index}`;
const extraTag = '141414141414141414';

async function seed(id = applicationId, user = ownerId, forum = ownerForum, thread: string | null = threadId, company = 'Example Company') {
	await env.disc_tracker_db.prepare(`INSERT INTO applications
		(id,owner_discord_id,forum_channel_id,discord_thread_id,company,position,applied_at,notes,job_url)
		VALUES (?,?,?,?,?,'Engineer','2026-10-11','My note','https://example.com/job')`).bind(id,user,forum,thread,company).run();
}
function command(status = 'Interview', id = interactionId, user = ownerId, app = applicationId): any {
	return { type: 2, id, application_id: '777777777777777777', token, guild_id: guildId,
		member: { user: { id: user } }, data: { type: 1, name: 'status', options: [
			{ type: 3, name: 'application', value: app }, { type: 3, name: 'status', value: status },
		] } };
}
function autocomplete(query = '', user = ownerId): any {
	return { ...command('Interview', interactionId, user), type: 4, data: { type: 1, name: 'status', options: [
		{ type: 3, name: 'application', value: query, focused: true },
	] } };
}
async function run(payload: unknown, bindings: Env = env) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(await signedRequest(JSON.stringify(payload)), bindings, ctx);
	expect(response.status).toBe(200);
	const reply = await response.json<any>();
	await waitOnExecutionContext(ctx);
	return reply;
}
async function row() { return env.disc_tracker_db.prepare('SELECT * FROM applications WHERE id = ?').bind(applicationId).first(); }
async function changes() { return (await env.disc_tracker_db.prepare('SELECT * FROM status_changes ORDER BY id').all()).results; }

type Call = { stage: string; url: string; body: any; request: Request };
function discord(options: { stage?: string; status?: number; throws?: boolean; missingTag?: boolean; duplicateTag?: boolean;
	wrongParent?: boolean; wrongGuild?: boolean; wrongType?: boolean; archived?: boolean; locked?: boolean;
	invalidHistory?: boolean; tags?: string[]; parentForum?: string; gate?: Promise<void>; started?: () => void } = {}) {
	const calls: Call[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const request = new Request(String(input), init);
		const url = request.url;
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		const forum = url.endsWith(ownerForum) ? ownerForum : friendForum;
		const stage = url.includes('/webhooks/') ? 'reply_edit'
			: request.method === 'GET' ? (url.endsWith(ownerForum) || url.endsWith(friendForum) ? 'forum_read' : 'thread_read')
			: request.method === 'POST' ? 'history_write'
			: url.includes('/messages/') ? 'starter_update'
			: body?.applied_tags ? 'tag_update' : 'restore';
		calls.push({ stage, url, body, request });
		if (stage === 'forum_read') { options.started?.(); await options.gate; }
		if (stage === options.stage) {
			if (options.throws) throw new Error(`sensitive ${token}`);
			return Response.json({ code: 50013, message: token }, { status: options.status ?? 403 });
		}
		if (stage === 'forum_read') return Response.json({ id: forum, type: 15, guild_id: guildId,
			available_tags: statuses.filter((name) => !options.missingTag || name !== 'Interview').map((name) => ({ id: tagId(statuses.indexOf(name)), name }))
				.concat(options.duplicateTag ? [{ id: '151515151515151515', name: 'Interview' }] : []) });
		if (stage === 'thread_read') return Response.json({ id: threadId, type: options.wrongType ? 0 : 11,
			guild_id: options.wrongGuild ? '161616161616161616' : guildId, parent_id: options.wrongParent ? friendForum : options.parentForum ?? ownerForum,
			applied_tags: options.tags ?? [tagId(0),extraTag], thread_metadata: { archived: !!options.archived, locked: !!options.locked } });
		if (stage === 'history_write') return Response.json(options.invalidHistory ? {} : { id: '171717171717171717' });
		return Response.json({ id: threadId });
	});
	return calls;
}
afterEach(() => vi.restoreAllMocks());

describe('status autocomplete', () => {
	it('suggests only owned, completed applications with no Discord REST calls', async () => {
		await seed();
		await seed('181818181818181818', friendId, friendForum, '191919191919191919', 'Friend secret');
		await seed('202020202020202020', ownerId, ownerForum, null, 'Pending');
		const fetch = vi.spyOn(globalThis, 'fetch');
		const reply = await run(autocomplete('example'));
		expect(reply.type).toBe(8);
		expect(reply.data.choices).toHaveLength(1);
		expect(reply.data.choices[0]).toMatchObject({ value: applicationId });
		expect(reply.data.choices[0].name).toContain('Example Company');
		expect(JSON.stringify(reply)).not.toMatch(/Friend secret|Pending/);
		expect(fetch).not.toHaveBeenCalled();
	});
	it('supports the friend route', async () => {
		await seed(applicationId,friendId,friendForum);
		expect((await run(autocomplete('',friendId))).data.choices[0].value).toBe(applicationId);
		expect((await run(autocomplete('',ownerId))).data.choices).toEqual([]);
	});
	it.each(['%', '_', "' OR 1=1 --", 'no match'])('treats search %s literally', async (query) => {
		await seed();
		expect((await run(autocomplete(query))).data.choices).toEqual([]);
	});
	it('limits suggestions to 25 and bounds long Unicode labels without broken surrogates', async () => {
		for (let n=0;n<30;n++) await seed(String(300000000000000000n + BigInt(n)),ownerId,ownerForum,String(400000000000000000n + BigInt(n)),'💼'.repeat(50));
		const choices = (await run(autocomplete())).data.choices;
		expect(choices).toHaveLength(25);
		for (const choice of choices) { expect(choice.name.length).toBeLessThanOrEqual(100); expect(choice.name).not.toMatch(/[\uD800-\uDBFF]$/); }
	});
	it.each(['unknown user','wrong guild','wrong app','DM','wrong focus','numeric query','duplicate option'])('returns no data for %s', async (label) => {
		const payload = autocomplete();
		if (label==='unknown user') payload.member.user.id='212121212121212121';
		if (label==='wrong guild') payload.guild_id='222222222222222222';
		if (label==='wrong app') payload.application_id='232323232323232323';
		if (label==='DM') { delete payload.guild_id; delete payload.member; payload.user={ id:ownerId }; }
		if (label==='wrong focus') payload.data.options[0].name='status';
		if (label==='numeric query') payload.data.options[0].value=123;
		if (label==='duplicate option') payload.data.options.push(payload.data.options[0]);
		const prepare=vi.spyOn(env.disc_tracker_db,'prepare');
		expect(await run(payload)).toEqual({type:8,data:{choices:[]}});
		expect(prepare).not.toHaveBeenCalled();
	});
	it('fails closed when D1 is unavailable', async () => {
		const bindings={...env,disc_tracker_db:{prepare:()=>{throw new Error(token);}} as unknown as D1Database};
		expect(await run(autocomplete(),bindings)).toEqual({type:8,data:{choices:[]}});
	});
});

describe('status updates', () => {
	it('updates the owned application, single status tag, starter display and history', async () => {
		await seed(); const calls=discord();
		expect(await run(command())).toEqual({type:5,data:{flags:64}});
		expect(await row()).toMatchObject({status:'Interview',status_change_id:null});
		expect(await changes()).toMatchObject([{id:interactionId,from_status:'Applied',to_status:'Interview',state:'complete',history_message_id:'171717171717171717'}]);
		expect(calls.find(c=>c.stage==='tag_update')?.body.applied_tags).toEqual([extraTag,tagId(3)]);
		const embed=calls.find(c=>c.stage==='starter_update')?.body.embeds[0];
		expect(embed.fields[0].value).toBe('Interview'); expect(embed.description).toBe('My note');
		expect(calls.find(c=>c.stage==='history_write')?.body).toMatchObject({content:'Applied → Interview',nonce:interactionId,enforce_nonce:true,allowed_mentions:{parse:[]}});
		expect(calls.at(-1)?.body.content).toContain('Status updated — Interview');
		expect(calls.every(c=>c.request.redirect==='manual')).toBe(true);
	});
	it('updates the friend route without touching the other owner', async () => {
		await seed(applicationId,friendId,friendForum); const calls=discord({parentForum:friendForum});
		await run(command('Offer',interactionId,friendId));
		expect(await row()).toMatchObject({owner_discord_id:friendId,status:'Offer'});
		expect(calls.find(c=>c.stage==='forum_read')?.url).toContain(friendForum);
	});
	it.each(statuses)('accepts status %s', async (status) => {
		await seed(); const calls=discord(); await run(command(status));
		expect((await row())?.status).toBe(status);
		expect(calls.filter(c=>c.stage==='history_write')).toHaveLength(status==='Applied'?0:1);
	});
	it.each(['unknown user','wrong guild','wrong app','DM','missing token','invalid status','numeric application','duplicate option','missing option'])('rejects %s before writes', async (label) => {
		const payload=command();
		if(label==='unknown user')payload.member.user.id='212121212121212121';
		if(label==='wrong guild')payload.guild_id='222222222222222222';
		if(label==='wrong app')payload.application_id='232323232323232323';
		if(label==='DM'){delete payload.guild_id;delete payload.member;payload.user={id:ownerId};}
		if(label==='missing token')delete payload.token;
		if(label==='invalid status')payload.data.options[1].value='Unknown';
		if(label==='numeric application')payload.data.options[0].value=123;
		if(label==='duplicate option')payload.data.options[1]=payload.data.options[0];
		if(label==='missing option')payload.data.options.pop();
		const calls=discord(); const prepare=vi.spyOn(env.disc_tracker_db,'prepare');
		expect((await run(payload)).type).toBe(4);
		expect(prepare).not.toHaveBeenCalled(); expect(calls).toHaveLength(0);
	});
	it.each(['other owner','unlinked application','wrong mapped forum','missing application'])('does not mutate Discord for %s', async(label)=>{
		if(label!=='missing application')await seed(applicationId,label==='other owner'?friendId:ownerId,label==='wrong mapped forum'?friendForum:ownerForum,label==='unlinked application'?null:threadId);
		const calls=discord();await run(command());
		expect(calls.map(c=>c.stage)).toEqual(['reply_edit']);
		expect(calls.at(-1)?.body.content).not.toContain('Status updated');
		expect(await changes()).toEqual([]);
	});
	it('does not replay old requests after a later successful change',async()=>{
		await seed();const calls=discord();await run(command());
		await run(command('Offer','242424242424242424'));
		await run(command());
		expect((await row())?.status).toBe('Offer');
		expect(calls.filter(c=>c.stage==='history_write')).toHaveLength(2);
		expect(calls.at(-1)?.body.content).toContain('already completed');
	});
	it('serializes concurrent commands and returns the ACK before REST finishes',async()=>{
		await seed();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
		let started!:()=>void;const entered=new Promise<void>(resolve=>started=resolve);const calls=discord({gate,started});
		const ctx=createExecutionContext();const response=await worker.fetch(await signedRequest(JSON.stringify(command())),env,ctx);
		expect(await response.json()).toEqual({type:5,data:{flags:64}});
		try { await entered; await run(command('Offer','242424242424242424')); } finally { release();await waitOnExecutionContext(ctx); }
		expect((await row())?.status).toBe('Interview');expect(calls.filter(c=>c.stage==='history_write')).toHaveLength(1);
	});
	it('does not repeat history for simultaneous duplicate deliveries',async()=>{
		await seed();const calls=discord();await Promise.all([run(command()),run(command())]);
		expect(calls.filter(c=>c.stage==='history_write')).toHaveLength(1);
		expect(await changes()).toHaveLength(1);
	});
	it('does not replay a busy request after newer successful changes',async()=>{
		await seed();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
		let started!:()=>void;const entered=new Promise<void>(resolve=>started=resolve);const calls=discord({gate,started});
		const first=run(command());
		try { await entered;await run(command('Offer','242424242424242424')); }
		finally { release();await first; }
		await run(command('Screening','252525252525252525'));
		await run(command('Offer','242424242424242424'));
		expect((await row())?.status).toBe('Screening');
		expect(calls.filter(c=>c.stage==='history_write')).toHaveLength(2);
		expect(await changes()).toContainEqual(expect.objectContaining({id:'242424242424242424',state:'failed',failure_stage:'busy'}));
	});
	it('records claim race losers and references the actual blocking request',async()=>{
		await seed();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const calls=discord({gate});
		let firstEntered!:()=>void;const entered=new Promise<void>(resolve=>firstEntered=resolve);
		let bothEntered!:()=>void;const both=new Promise<void>(resolve=>bothEntered=resolve);
		let firstCommitted!:()=>void;const committed=new Promise<void>(resolve=>firstCommitted=resolve);let claims=0;
		const bindings={...env,disc_tracker_db:{prepare:(sql:string)=>env.disc_tracker_db.prepare(sql),batch:async(statements:D1PreparedStatement[])=>{
			if(++claims===1){firstEntered();await both;const result=await env.disc_tracker_db.batch(statements);firstCommitted();return result;}
			if(claims===2){bothEntered();await committed;}
			return env.disc_tracker_db.batch(statements);
		}} as unknown as D1Database};
		const first=run(command(),bindings);
		try { await entered;await run(command('Offer','242424242424242424'),bindings);
			expect(calls.at(-1)?.body.content).toContain(`Reference: ${interactionId}`);
			expect(await changes()).toContainEqual(expect.objectContaining({id:'242424242424242424',state:'failed'}));
		} finally { release();await first; }
		await run(command('Screening','252525252525252525'));
		await run(command('Offer','242424242424242424'));
		expect((await row())?.status).toBe('Screening');expect(calls.filter(c=>c.stage==='history_write')).toHaveLength(2);
	});
	it.each([{archived:true,locked:false},{archived:true,locked:true},{archived:false,locked:true}])('restores archived/locked metadata ($archived/$locked)',async(options)=>{
		await seed();const calls=discord(options);await run(command());
		expect(calls.find(c=>c.stage==='tag_update')?.body.archived).toBe(false);
		expect(calls.find(c=>c.stage==='tag_update')?.body.locked).toBe(options.locked?false:undefined);
		expect(calls.find(c=>c.stage==='restore')?.body).toEqual(options);
		expect((await row())?.status).toBe('Interview');
	});
	it('removes multiple status tags while retaining non-status tags',async()=>{
		await seed();const calls=discord({tags:[tagId(0),tagId(1),extraTag]});await run(command());
		expect(calls.find(c=>c.stage==='tag_update')?.body.applied_tags).toEqual([extraTag,tagId(3)]);
	});
	it.each([
		{label:'missing tag',options:{missingTag:true}},{label:'duplicate tag',options:{duplicateTag:true}},
		{label:'wrong parent',options:{wrongParent:true}},{label:'wrong guild',options:{wrongGuild:true}},{label:'wrong type',options:{wrongType:true}},
		{label:'too many non-status tags',options:{tags:Array.from({length:5},(_,n)=>`31313131313131313${n}`)}},
		{label:'Forum read rejection',options:{stage:'forum_read',status:403}},{label:'thread read failure',options:{stage:'thread_read',throws:true}},
	])('releases a claim after preflight failure: $label',async({options})=>{
		await seed();const calls=discord(options);await run(command());
		expect(await row()).toMatchObject({status:'Applied',status_change_id:null});
		expect(await changes()).toMatchObject([{state:'failed'}]);
		expect(calls.filter(c=>c.request.method!=='GET').map(c=>c.stage)).toEqual(['reply_edit']);
		expect(calls.at(-1)?.body.content).not.toContain('Status updated');
	});
	it.each(['tag_update','starter_update','history_write','restore'])('holds the claim after a partial failure at %s',async(stage)=>{
		await seed();const calls=discord({stage,status:403,archived:stage==='restore'});await run(command());
		expect(await row()).toMatchObject({status:'Applied',status_change_id:interactionId});
		expect(await changes()).toMatchObject([{state:'needs_check',failure_stage:stage}]);
		expect(calls.at(-1)?.body.content).toContain('Do not repeat');
		const priorWrites=calls.filter(c=>c.request.method!=='GET'&&c.stage!=='reply_edit').length;
		await run(command('Offer','242424242424242424'));
		expect(calls.filter(c=>c.request.method!=='GET'&&c.stage!=='reply_edit')).toHaveLength(priorWrites);
	});
	it.each([{throws:true},{status:500},{invalidHistory:true}])('does not retry an uncertain history write ($throws/$status/$invalidHistory)',async(options)=>{
		await seed();const calls=discord({...options,...(!options.invalidHistory?{stage:'history_write'}:{})});await run(command());await run(command());
		expect(calls.filter(c=>c.stage==='history_write')).toHaveLength(1);
		expect(await changes()).toMatchObject([{state:'needs_check'}]);
	});
	it('retains the claim if committing after Discord success fails',async()=>{
		await seed();const calls=discord();let batches=0;
		const bindings={...env,disc_tracker_db:{prepare:(sql:string)=>env.disc_tracker_db.prepare(sql),batch:(statements:D1PreparedStatement[])=>{
			if(++batches===2)throw new Error(token);return env.disc_tracker_db.batch(statements);
		}} as unknown as D1Database};
		await run(command(),bindings);
		expect(await row()).toMatchObject({status:'Applied',status_change_id:interactionId});
		expect(await changes()).toMatchObject([{state:'needs_check',failure_stage:'database_commit',history_message_id:'171717171717171717'}]);
		expect(calls.at(-1)?.body.content).toContain('Do not repeat');
	});
	it('keeps a completed change when the private confirmation fails',async()=>{
		await seed();discord({stage:'reply_edit',status:500});const log=vi.spyOn(console,'error').mockImplementation(()=>{});await run(command());
		expect((await row())?.status).toBe('Interview');expect(await changes()).toMatchObject([{state:'complete'}]);
		expect(log).toHaveBeenCalled();expect(JSON.stringify(log.mock.calls)).not.toContain(token);
	});
	it('does not touch Discord when claim storage is unavailable',async()=>{
		const calls=discord();const bindings={...env,disc_tracker_db:{prepare:()=>{throw new Error(token);}} as unknown as D1Database};
		await run(command(),bindings);expect(calls.map(c=>c.stage)).toEqual(['reply_edit']);
		expect(calls.at(-1)?.body.content).toContain('Database');
	});
});
