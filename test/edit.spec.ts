import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { ownerId, friendId, guildId, signedRequest } from './helpers';

const app = '888888888888888888';
const form = '999999999999999999';
const secondForm = '242424242424242424';
const thirdForm = '252525252525252525';
const thread = '666666666666666666';
const ownerForum = '333333333333333333';
const friendForum = '444444444444444444';
const token = 'edit-fixture-token';
const original = { company:'Example Company', position:'Engineer', job_url:'https://example.com/job', notes:'My note' };
const edited = { company:'Correct Company', position:'Backend Engineer', job_url:'https://example.com/new', notes:'Updated note' };
const stages = ['Applied','Screening','Assessment','Interview','Offer','Rejected','Withdrawn'];

async function seed(user=ownerId, forum=ownerForum, linked:string|null=thread) {
	await env.disc_tracker_db.prepare(`INSERT INTO applications
		(id,owner_discord_id,forum_channel_id,discord_thread_id,company,position,job_url,notes,source,status,applied_at)
		VALUES (?,?,?,?,?,?,?,?, 'Referral','Interview','2026-10-11')`)
		.bind(app,user,forum,linked,original.company,original.position,original.job_url,original.notes).run();
}
function command(id=form,user=ownerId): any {
	return {type:2,id,application_id:'777777777777777777',guild_id:guildId,member:{user:{id:user}},
		data:{type:1,name:'edit',options:[{type:3,name:'application',value:app}]}};
}
function submission(id=form,user=ownerId,values:Partial<typeof original>=edited): any {
	return {...command('282828282828282828',user),type:5,token,data:{custom_id:`edit:${id}:${user}`,
		components:Object.entries({...original,...values}).map(([custom_id,value])=>({type:18,component:{type:4,custom_id,value}}))}};
}
function statusCommand(id='272727272727272727'): any {
	return {...command(id),token,data:{type:1,name:'status',options:[{type:3,name:'application',value:app},{type:3,name:'status',value:'Offer'}]}};
}
function autocomplete(query='',user=ownerId): any {
	return {...command(form,user),type:4,data:{type:1,name:'edit',options:[{type:3,name:'application',value:query,focused:true}]}};
}
async function run(payload:unknown,bindings:Env=env) {
	const ctx=createExecutionContext();const response=await worker.fetch(await signedRequest(JSON.stringify(payload)),bindings,ctx);
	expect(response.status).toBe(200);const reply=await response.json<any>();await waitOnExecutionContext(ctx);return reply;
}
async function row() {return env.disc_tracker_db.prepare('SELECT * FROM applications WHERE id = ?').bind(app).first<any>();}
async function attempt(id=form) {return env.disc_tracker_db.prepare('SELECT * FROM application_edits WHERE id = ?').bind(id).first<any>();}
type Call={stage:string;request:Request;body:any};
function discord(options:{stage?:string;http?:number;throws?:boolean;wrongParent?:boolean;wrongGuild?:boolean;wrongType?:boolean;
	archived?:boolean;locked?:boolean;parent?:string;gate?:Promise<void>;started?:()=>void}={}) {
	const calls:Call[]=[];
	vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
		const request=new Request(String(input),init);const url=request.url;const body=init?.body?JSON.parse(String(init.body)):null;
		const forum=url.endsWith(ownerForum)?ownerForum:friendForum;
		const stage=url.includes('/webhooks/')?'reply_edit':request.method==='GET'
			?(url.endsWith(ownerForum)||url.endsWith(friendForum)?'forum_read':'thread_read')
			:request.method==='POST'?'history_write':url.includes('/messages/')?'starter_update'
			:body?.name?'rename':body?.applied_tags?'tag_update':'restore';
		calls.push({stage,request,body});
		if(stage==='forum_read'){options.started?.();await options.gate;}
		if(stage===options.stage){if(options.throws)throw new Error(token);return Response.json({code:50013,message:token},{status:options.http??403});}
		if(stage==='forum_read')return Response.json({id:forum,type:15,guild_id:guildId,available_tags:stages.map((name,n)=>({id:`13131313131313131${n}`,name}))});
		if(stage==='thread_read')return Response.json({id:thread,type:options.wrongType?0:11,guild_id:options.wrongGuild?'161616161616161616':guildId,
			parent_id:options.wrongParent?friendForum:options.parent??ownerForum,name:'Example Company — Engineer',applied_tags:['131313131313131313','141414141414141414'],
			thread_metadata:{archived:!!options.archived,locked:!!options.locked}});
		return Response.json({id:stage==='history_write'?'171717171717171717':thread});
	});return calls;
}
afterEach(()=>vi.restoreAllMocks());

describe('edit forms and autocomplete',()=>{
	it('opens a prefilled four-field modal without Discord REST or a claim',async()=>{
		await seed();const calls=discord();const reply=await run(command());
		expect(reply.type).toBe(9);expect(reply.data.custom_id).toBe(`edit:${form}:${ownerId}`);
		expect(reply.data.components.map((c:any)=>[c.type,c.component.type,c.component.custom_id,c.component.value,c.component.required]))
			.toEqual([[18,4,'company',original.company,true],[18,4,'position',original.position,true],[18,4,'job_url',original.job_url,false],[18,4,'notes',original.notes,false]]);
		expect(calls).toHaveLength(0);expect((await row()).status_change_id).toBeNull();
		expect(await attempt()).toMatchObject({application_id:app,state:'open',base_version:0});
	});
	it('supports the friend route without disclosing it to the other owner',async()=>{
		await seed(friendId,friendForum);discord({parent:friendForum});
		expect((await run(command(form,ownerId))).type).toBe(4);
		expect((await run(command(form,friendId))).type).toBe(9);
		await run(submission(form,friendId));expect((await row()).company).toBe(edited.company);
	});
	it('deduplicates repeated command delivery to one form snapshot',async()=>{
		await seed();discord();expect(await run(command())).toEqual(await run(command()));
		expect(await env.disc_tracker_db.prepare('SELECT COUNT(*) AS count FROM application_edits').first('count')).toBe(1);
	});
	it.each(['other owner','unlinked','wrong Forum','missing application'])('does not open an unavailable application: %s',async(label)=>{
		if(label!=='missing application')await seed(label==='other owner'?friendId:ownerId,label==='wrong Forum'?friendForum:ownerForum,label==='unlinked'?null:thread);
		const calls=discord();expect((await run(command())).type).toBe(4);expect(calls).toHaveLength(0);
	});
	it.each(['unknown user','wrong guild','wrong app','numeric ID','DM','missing option','duplicate option','wrong type','focused option'])('rejects invalid edit command: %s',async(label)=>{
		const payload=command();if(label==='unknown user')payload.member.user.id='212121212121212121';
		if(label==='wrong guild')payload.guild_id='212121212121212121';if(label==='wrong app')payload.application_id='212121212121212121';
		if(label==='numeric ID')payload.id=123;if(label==='DM'){delete payload.guild_id;delete payload.member;payload.user={id:ownerId};}
		if(label==='missing option')payload.data.options=[];if(label==='duplicate option')payload.data.options.push(payload.data.options[0]);
		if(label==='wrong type')payload.data.options[0].type=4;if(label==='focused option')payload.data.options[0].focused=true;
		const calls=discord();const prepare=vi.spyOn(env.disc_tracker_db,'prepare');expect((await run(payload)).type).toBe(4);
		expect(prepare).not.toHaveBeenCalled();expect(calls).toHaveLength(0);
	});
	it('suggests only owned linked applications and hides active claims',async()=>{
		await seed();const calls=discord();expect((await run(autocomplete('example'))).data.choices).toMatchObject([{value:app}]);
		expect((await run(autocomplete('',friendId))).data.choices).toEqual([]);
		await env.disc_tracker_db.prepare('UPDATE applications SET status_change_id = ? WHERE id = ?').bind(form,app).run();
		expect((await run(autocomplete())).data.choices).toEqual([]);expect(calls).toHaveLength(0);
	});
	it.each(['%',"' OR 1=1 --"])('searches literal text %s',async(query)=>{await seed();discord();expect((await run(autocomplete(query))).data.choices).toEqual([]);});
	it('rejects status-only options in edit autocomplete',async()=>{
		const payload=autocomplete();payload.data.options.push({type:3,name:'status',value:'Offer'});
		const prepare=vi.spyOn(env.disc_tracker_db,'prepare');expect((await run(payload)).data.choices).toEqual([]);expect(prepare).not.toHaveBeenCalled();
	});
	it('fails privately when storage for opening forms is unavailable',async()=>{
		const bindings={...env,disc_tracker_db:{prepare:()=>{throw new Error(token);}} as unknown as D1Database};const calls=discord();
		expect((await run(command(),bindings)).data.content).toContain('Database');expect(calls).toHaveLength(0);
	});
});

describe('edit submission',()=>{
	it('updates details and the existing post title/embed, preserving status, dates, tags and history',async()=>{
		await seed();const calls=discord();await run(command());const before=await row();
		expect(await run(submission())).toEqual({type:5,data:{flags:64}});
		expect(await row()).toMatchObject({...edited,id:app,status:'Interview',source:'Referral',applied_at:before.applied_at,created_at:before.created_at,
			owner_discord_id:ownerId,discord_thread_id:thread,details_version:1,status_change_id:null});
		expect(await attempt()).toMatchObject({state:'complete'});
		expect(calls.find(c=>c.stage==='rename')?.body).toEqual({name:'Correct Company — Backend Engineer',archived:false});
		const patch=calls.find(c=>c.stage==='starter_update')!;expect(patch.request.url).toContain(`/channels/${thread}/messages/${thread}`);
		expect(patch.body.embeds[0].fields[0].value).toBe('Interview');expect(patch.body.embeds[0].description).toBe(edited.notes);
		expect(patch.body.allowed_mentions).toEqual({parse:[]});expect(calls.some(c=>c.stage==='tag_update'||c.stage==='history_write')).toBe(false);
		expect(calls.at(-1)?.body.content).toContain('Application updated');expect(calls.every(c=>c.request.redirect==='manual')).toBe(true);
	});
	it('clears optional fields when their inputs are blank',async()=>{
		await seed();const calls=discord();await run(command());await run(submission(form,ownerId,{job_url:' ',notes:''}));
		expect(await row()).toMatchObject({job_url:null,notes:null});const embed=calls.find(c=>c.stage==='starter_update')?.body.embeds[0];
		expect(embed.description).toBeUndefined();expect(embed.fields.some((f:any)=>f.name==='Job URL')).toBe(false);
	});
	it('makes no post mutation for unchanged values',async()=>{
		await seed();const calls=discord();await run(command());const before=await row();await run(submission(form,ownerId,original));
		expect(await row()).toEqual(before);expect(await attempt()).toMatchObject({state:'complete'});
		expect(calls.map(c=>c.stage)).toEqual(['reply_edit']);expect(calls.at(-1)?.body.content).toContain('No changes');
	});
	it.each([{archived:true,locked:false},{archived:true,locked:true},{archived:false,locked:true}])('restores archived/locked state ($archived/$locked)',async(options)=>{
		await seed();const calls=discord(options);await run(command());await run(submission());
		expect(calls.find(c=>c.stage==='restore')?.body).toEqual(options);expect((await row()).company).toBe(edited.company);
		expect(JSON.parse((await attempt()).thread_metadata)).toMatchObject(options);
	});
	it('bounds Unicode post titles and suppresses mentions',async()=>{
		await seed();const calls=discord();await run(command());await run(submission(form,ownerId,{company:'💼'.repeat(50),position:'@everyone',notes:'@here'}));
		const title=calls.find(c=>c.stage==='rename')?.body.name;expect(title.length).toBeLessThanOrEqual(100);expect(title).not.toMatch(/[\uD800-\uDBFF]$/);
		expect(calls.find(c=>c.stage==='starter_update')?.body.allowed_mentions).toEqual({parse:[]});
	});
	it.each([
		{label:'blank company',values:{company:' '}},{label:'long company',values:{company:'x'.repeat(101)}},
		{label:'multiline position',values:{position:'One\nTwo'}},{label:'blank role',values:{position:''}},
		{label:'bad URL',values:{job_url:'no URL'}},{label:'script URL',values:{job_url:'javascript:alert(1)'}},
		{label:'credentials in URL',values:{job_url:'https://user:password@example.com'}},{label:'long URL',values:{job_url:'https://example.com/'+ 'x'.repeat(1000)}},
		{label:'long notes',values:{notes:'x'.repeat(2001)}},
	])('rejects invalid values before any writes: $label',async({values})=>{
		await seed();const calls=discord();await run(command());const before=await row();const prepare=vi.spyOn(env.disc_tracker_db,'prepare');
		expect((await run(submission(form,ownerId,values))).type).toBe(4);expect(prepare).not.toHaveBeenCalled();expect(calls).toHaveLength(0);expect(await row()).toEqual(before);
	});
	it.each(['another owner','missing token','wrong application','duplicate field','missing optional field','unknown field','invalid form ID'])('rejects malformed submissions: %s',async(label)=>{
		const payload=submission();if(label==='another owner')payload.member.user.id=friendId;if(label==='missing token')delete payload.token;
		if(label==='wrong application')payload.application_id='212121212121212121';if(label==='duplicate field')payload.data.components[1]=payload.data.components[0];
		if(label==='missing optional field')payload.data.components.pop();if(label==='unknown field')payload.data.components[0].component.custom_id='status';
		if(label==='invalid form ID')payload.data.custom_id='edit:nope';const calls=discord();const prepare=vi.spyOn(env.disc_tracker_db,'prepare');
		expect((await run(payload)).type).toBe(4);expect(prepare).not.toHaveBeenCalled();expect(calls).toHaveLength(0);
	});
	it('requires a server-side owned form record rather than trusting its custom ID',async()=>{
		await seed();const calls=discord();await run(submission());expect((await row()).company).toBe(original.company);expect(calls.map(c=>c.stage)).toEqual(['reply_edit']);
	});
	it('rejects stale forms and retains their terminal outcome against later replay',async()=>{
		await seed();const calls=discord();await run(command());await run(command(secondForm));await run(submission());
		await run(submission(secondForm,ownerId,{company:'Stale Company'}));expect(calls.at(-1)?.body.content).toContain('changed');
		expect(await attempt(secondForm)).toMatchObject({state:'failed',failure_stage:'stale'});
		await run(command(thirdForm));await run(submission(thirdForm,ownerId,{company:'Newest Company'}));
		await run(submission(secondForm,ownerId,{company:'Stale Company'}));expect((await row()).company).toBe('Newest Company');
		expect(calls.filter(c=>c.stage==='starter_update')).toHaveLength(2);
	});
	it('does not replay completed forms after a newer edit',async()=>{
		await seed();const calls=discord();await run(command());await run(submission());await run(command(secondForm));
		await run(submission(secondForm,ownerId,{company:'Newest Company'}));await run(submission());
		expect((await row()).company).toBe('Newest Company');expect(calls.filter(c=>c.stage==='starter_update')).toHaveLength(2);
	});
	it('uses the current status if it changed while the form was open',async()=>{
		await seed();const calls=discord();await run(command());await run(statusCommand());await run(submission());
		expect((await row()).status).toBe('Offer');expect(calls.filter(c=>c.stage==='starter_update').at(-1)?.body.embeds[0].fields[0].value).toBe('Offer');
	});
	it('serializes duplicate submissions to one post mutation',async()=>{
		await seed();const calls=discord();await run(command());await Promise.all([run(submission()),run(submission())]);
		expect(calls.filter(c=>c.stage==='starter_update')).toHaveLength(1);expect((await row()).details_version).toBe(1);
	});
	it.each(['edit','status'])('blocks a concurrent %s while an edit holds the claim',async(other)=>{
		await seed();let release!:()=>void;const gate=new Promise<void>(r=>release=r);let started!:()=>void;const entered=new Promise<void>(r=>started=r);
		const calls=discord({gate,started});await run(command());await run(command(secondForm));const first=run(submission());
		try{await entered;await run(other==='edit'?submission(secondForm,ownerId,{company:'Other Company'}):statusCommand());}
		finally{release();await first;}
		expect((await row()).company).toBe(edited.company);expect((await row()).status).toBe('Interview');
		expect(calls.filter(c=>c.stage==='starter_update')).toHaveLength(1);
		await run(other==='edit'?submission(secondForm,ownerId,{company:'Other Company'}):statusCommand());
		expect((await row()).company).toBe(edited.company);expect((await row()).status).toBe('Interview');
	});
	it('blocks edit submission while a status update holds the claim',async()=>{
		await seed();let release!:()=>void;const gate=new Promise<void>(r=>release=r);let started!:()=>void;const entered=new Promise<void>(r=>started=r);
		const calls=discord({gate,started});await run(command());const first=run(statusCommand());
		try{await entered;await run(submission());}finally{release();await first;}
		expect((await row()).company).toBe(original.company);expect((await row()).status).toBe('Offer');
		expect(await attempt()).toMatchObject({state:'failed',failure_stage:'busy'});expect(calls.filter(c=>c.stage==='rename')).toHaveLength(0);
		await run(submission());expect((await row()).company).toBe(original.company);
	});
	it('prevents a status claim from rendering a details snapshot superseded by an edit',async()=>{
		await seed();const calls=discord();await run(command());let release!:()=>void;const gate=new Promise<void>(r=>release=r);
		let started!:()=>void;const entered=new Promise<void>(r=>started=r);let batches=0;
		const bindings={...env,disc_tracker_db:{prepare:(sql:string)=>env.disc_tracker_db.prepare(sql),batch:async(statements:D1PreparedStatement[])=>{
			if(++batches===1){started();await gate;}return env.disc_tracker_db.batch(statements);
		}} as unknown as D1Database};const status=run(statusCommand(),bindings);
		try{await entered;await run(submission());}finally{release();await status;}
		expect(await row()).toMatchObject({company:edited.company,status:'Interview'});expect(calls.filter(c=>c.stage==='starter_update')).toHaveLength(1);
	});
	it.each([{wrongParent:true},{wrongGuild:true},{wrongType:true},{stage:'forum_read',http:403},{stage:'thread_read',throws:true}])('releases safe preflight failure ($stage/$wrongParent/$wrongGuild/$wrongType)',async(options)=>{
		await seed();const calls=discord(options);await run(command());await run(submission());
		expect(await row()).toMatchObject({company:original.company,status_change_id:null});expect(await attempt()).toMatchObject({state:'failed',failure_stage:'preflight'});
		expect(calls.filter(c=>c.request.method!=='GET').map(c=>c.stage)).toEqual(['reply_edit']);
	});
	it.each(['rename','starter_update','restore'])('retains a claim after uncertain mutation at %s',async(stage)=>{
		await seed();const calls=discord({stage,archived:stage==='restore'});await run(command());await run(submission());
		expect(await row()).toMatchObject({company:original.company,status_change_id:form});expect(await attempt()).toMatchObject({state:'needs_check',failure_stage:stage});
		expect(calls.at(-1)?.body.content).toContain('Do not repeat');const writes=calls.filter(c=>c.request.method!=='GET'&&c.stage!=='reply_edit').length;
		await run(submission());await run(statusCommand());expect(calls.filter(c=>c.request.method!=='GET'&&c.stage!=='reply_edit')).toHaveLength(writes);
	});
	it.each([{http:302},{http:500},{throws:true}])('retains uncertain rename outcomes ($http/$throws)',async(options)=>{
		await seed();const calls=discord({stage:'rename',...options});await run(command());await run(submission());await run(submission());
		expect(await attempt()).toMatchObject({state:'needs_check'});expect(calls.filter(c=>c.stage==='rename')).toHaveLength(1);
	});
	it('retains old details and claim when the database commit fails after Discord succeeds',async()=>{
		await seed();const calls=discord();await run(command());const bindings={...env,disc_tracker_db:{prepare:(sql:string)=>env.disc_tracker_db.prepare(sql),
			batch:(statements:D1PreparedStatement[])=>env.disc_tracker_db.batch(statements)
		} as unknown as D1Database};
		// Fail the application detail UPDATE at preparation; claims and recovery still use real D1.
		bindings.disc_tracker_db.prepare=(sql:string)=>{if(sql.startsWith('UPDATE applications SET company'))throw new Error(token);return env.disc_tracker_db.prepare(sql);};
		await run(submission(),bindings);expect(await row()).toMatchObject({company:original.company,status_change_id:form});
		expect(await attempt()).toMatchObject({state:'needs_check',failure_stage:'database_commit'});expect(calls.at(-1)?.body.content).toContain('Do not repeat');
	});
	it('keeps a completed edit when its private confirmation fails without leaking secrets',async()=>{
		await seed();discord({stage:'reply_edit',http:500});await run(command());const log=vi.spyOn(console,'error').mockImplementation(()=>{});await run(submission());
		expect((await row()).company).toBe(edited.company);expect(await attempt()).toMatchObject({state:'complete'});
		expect(log).toHaveBeenCalled();expect(JSON.stringify(log.mock.calls)).not.toContain(token);
	});
	it('releases the claim without Forum writes when original metadata cannot be saved',async()=>{
		await seed();const calls=discord();await run(command());
		const bindings={...env,disc_tracker_db:{prepare:(sql:string)=>{
			if(sql.startsWith('UPDATE application_edits SET thread_metadata'))throw new Error(token);
			return env.disc_tracker_db.prepare(sql);
		},batch:(statements:D1PreparedStatement[])=>env.disc_tracker_db.batch(statements)} as unknown as D1Database};
		await run(submission(),bindings);expect(await row()).toMatchObject({company:original.company,status_change_id:null});
		expect(await attempt()).toMatchObject({state:'failed',failure_stage:'preflight'});
		expect(calls.filter(c=>c.request.method!=='GET').map(c=>c.stage)).toEqual(['reply_edit']);
	});
	it('retains a pending claim if saving a preflight failure outcome is unavailable',async()=>{
		await seed();const calls=discord({wrongParent:true});await run(command());let batches=0;
		const bindings={...env,disc_tracker_db:{prepare:(sql:string)=>env.disc_tracker_db.prepare(sql),batch:(statements:D1PreparedStatement[])=>{
			if(++batches===2)throw new Error(token);return env.disc_tracker_db.batch(statements);
		}} as unknown as D1Database};
		await run(submission(),bindings);expect(await row()).toMatchObject({company:original.company,status_change_id:form});
		expect(await attempt()).toMatchObject({state:'pending'});expect(calls.at(-1)?.body.content).toContain('Do not repeat');
		await run(submission());expect(calls.filter(c=>c.stage==='rename'||c.stage==='starter_update')).toHaveLength(0);
	});
	it.each(['edit','status'])('retains a terminal claim-losing form when another %s finishes between read and claim',async(other)=>{
		await seed();const calls=discord();await run(command());await run(command(secondForm));
		let release!:()=>void;const gate=new Promise<void>(r=>release=r);let started!:()=>void;const entered=new Promise<void>(r=>started=r);let batches=0;
		const bindings={...env,disc_tracker_db:{prepare:(sql:string)=>env.disc_tracker_db.prepare(sql),batch:async(statements:D1PreparedStatement[])=>{
			if(++batches===1){started();await gate;}return env.disc_tracker_db.batch(statements);
		}} as unknown as D1Database};const first=run(submission(),bindings);
		try{await entered;await run(other==='edit'?submission(secondForm,ownerId,{company:'Newest Company'}):statusCommand());}
		finally{release();await first;}
		expect(await attempt()).toMatchObject({state:'failed',failure_stage:'claim_lost'});
		const before=await row();await run(submission());expect(await row()).toEqual(before);
		expect(before.company).toBe(other==='edit'?'Newest Company':original.company);expect(before.status).toBe(other==='status'?'Offer':'Interview');
		expect(calls.filter(c=>c.stage==='starter_update')).toHaveLength(1);
	});
});
