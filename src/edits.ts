import { isDiscordId, isRecord, type ApplicationInput } from './apply-form';
import { applicationEmbed, applicationTitle } from './application-embed';
import type { UserForum } from './authorization';
import { discordRequest, editPrivateReply, noMentions } from './discord';
import { editModal, type EditInput } from './edit-form';
import { isStatus } from './status-form';

type Details = Omit<ApplicationInput, 'id'>;
interface ApplicationRow {
	id: string; company: string; position: string; job_url: string | null; notes: string | null;
	applied_at: string; status: string; discord_thread_id: string | null; status_change_id: string | null; details_version: number;
}
interface EditRow extends ApplicationRow {
	application_id: string; base_version: number; before_details: string; after_details: string | null; state: string;
}
class EditError extends Error {}
const privateReply = (content: string) => Response.json({ type: 4, data: { content, flags: 64 } });
const checking = (id: string) => `An application change is processing or needs checking. Do not repeat it until checked. Reference: ${id}.`;
const detailsOf = (row: ApplicationRow): Details => ({ company: row.company, position: row.position, jobUrl: row.job_url, notes: row.notes });
const encodeDetails = (details: Details) => JSON.stringify({ company: details.company, position: details.position, jobUrl: details.jobUrl, notes: details.notes });

function snapshot(value: string): Details | null {
	const data: unknown = JSON.parse(value);
	return isRecord(data) && typeof data.company === 'string' && typeof data.position === 'string' &&
		(data.jobUrl === null || typeof data.jobUrl === 'string') && (data.notes === null || typeof data.notes === 'string')
		? { company: data.company, position: data.position, jobUrl: data.jobUrl, notes: data.notes } : null;
}

/** The form snapshot is durable, but merely opening a modal does not claim the application. */
export async function openEdit(app: string, user: UserForum, id: string, env: Env): Promise<Response> {
	const db = env.disc_tracker_db;
	try {
		const row = await db.prepare('SELECT * FROM applications WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ?')
			.bind(app, user.ownerDiscordId, user.forumChannelId).first<ApplicationRow>();
		if (!row || !isDiscordId(row.discord_thread_id) || !isStatus(row.status)) return privateReply('That application is unavailable. Choose one of your saved applications.');
		if (row.status_change_id) return privateReply(checking(row.status_change_id));
		await db.prepare(`INSERT INTO application_edits (id, application_id, base_version, before_details)
			SELECT ?, id, details_version, ? FROM applications WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ?
			AND details_version = ? AND status_change_id IS NULL AND discord_thread_id = ? ON CONFLICT(id) DO NOTHING`)
			.bind(id, encodeDetails(detailsOf(row)), app, user.ownerDiscordId, user.forumChannelId, row.details_version, row.discord_thread_id).run();
		const form = await db.prepare(`SELECT e.application_id, e.base_version, e.before_details, e.state FROM application_edits e
			JOIN applications a ON a.id = e.application_id WHERE e.id = ? AND a.owner_discord_id = ? AND a.forum_channel_id = ?`)
			.bind(id, user.ownerDiscordId, user.forumChannelId).first<{ application_id: string; base_version: number; before_details: string; state: string }>();
		if (!form || form.application_id !== app || form.base_version !== row.details_version || form.state !== 'open')
			return privateReply('This form is no longer available or the application changed. Run /edit again.');
		const details = snapshot(form.before_details);
		if (!details) return privateReply('The saved form needs checking. Run /edit again.');
		return Response.json(editModal(id, user.ownerDiscordId, { id: app, ...details }));
	} catch { return privateReply('Database could not open this edit form. Check the migration, then run /edit again.'); }
}

export async function saveEdit(input: EditInput, user: UserForum, env: Env): Promise<string> {
	const db = env.disc_tracker_db;
	const id = input.formId;
	const owner = user.ownerDiscordId;
	let row: EditRow;
	const after = encodeDetails(input.details);
	try {
		const found = await db.prepare(`SELECT a.*, e.application_id, e.base_version, e.before_details, e.after_details, e.state
			FROM application_edits e JOIN applications a ON a.id = e.application_id
			WHERE e.id = ? AND a.owner_discord_id = ? AND a.forum_channel_id = ?`)
			.bind(id, owner, user.forumChannelId).first<EditRow>();
		if (!found || !isDiscordId(found.discord_thread_id) || !isStatus(found.status)) return 'This edit form is unavailable. Run /edit again and choose one of your saved applications.';
		row = found;
		if (row.state === 'complete') return `This edit was already completed. https://discord.com/channels/${env.DISCORD_GUILD_ID}/${row.discord_thread_id}`;
		if (row.state === 'failed') return 'This edit attempt did not complete. Check the application, then run /edit again.';
		if (row.state !== 'open') return checking(id);
		const rejected = async (stage: string) => {
			// A rejected form stays terminal: later redelivery must not undo a newer edit.
			await db.prepare(`UPDATE application_edits SET state = 'failed', failure_stage = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
				WHERE id = ? AND state = 'open' AND EXISTS (SELECT 1 FROM applications a WHERE a.id = application_edits.application_id
				AND a.owner_discord_id = ? AND a.forum_channel_id = ?)`).bind(stage,id,owner,user.forumChannelId).run();
			const latest = await db.prepare('SELECT status_change_id FROM applications WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ?')
				.bind(row.id, owner, user.forumChannelId).first<{ status_change_id: string | null }>();
			return latest?.status_change_id ? checking(latest.status_change_id) : 'The application changed or another change was processing. Run /edit again to load the latest details.';
		};
		if (row.status_change_id) return await rejected('busy');
		if (row.details_version !== row.base_version) return await rejected('stale');
		// Status and edits share this existing slot; only one may mutate the post at a time.
		const claimed = await db.batch([
			db.prepare(`UPDATE application_edits SET state = 'pending', after_details = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
				WHERE id = ? AND state = 'open' AND EXISTS (SELECT 1 FROM applications a WHERE a.id = application_edits.application_id
				AND a.owner_discord_id = ? AND a.forum_channel_id = ? AND a.details_version = application_edits.base_version
				AND a.status = ? AND a.discord_thread_id = ? AND a.status_change_id IS NULL)`)
				.bind(after,id,owner,user.forumChannelId,row.status,row.discord_thread_id),
			db.prepare(`UPDATE applications SET status_change_id = ? WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ?
				AND details_version = ? AND status = ? AND discord_thread_id = ? AND status_change_id IS NULL
				AND EXISTS (SELECT 1 FROM application_edits WHERE id = ? AND application_id = ? AND state = 'pending')`)
				.bind(id,row.id,owner,user.forumChannelId,row.base_version,row.status,row.discord_thread_id,id,row.id),
		]);
		if (claimed.some(result => result.meta.changes !== 1)) return await rejected('claim_lost');
	} catch { return 'Database could not start this edit. Check the migration and application before retrying.'; }

	const link = `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${row.discord_thread_id}`;
	const changed = after !== encodeDetails(detailsOf(row));
	let stage = 'preflight';
	let mutating = false;
	try {
		if (changed) {
			const request = async (path: string, method = 'GET', body?: unknown) => {
				const response = await discordRequest(path,env.DISCORD_TOKEN,method,body,3000);
				if (!response.ok) throw new EditError(`Discord could not finish ${stage.replaceAll('_',' ')} (HTTP ${response.status}). Check bot access and permissions.`);
				return response;
			};
			const [forumResponse,threadResponse] = await Promise.all([request(`/channels/${user.forumChannelId}`),request(`/channels/${row.discord_thread_id}`)]);
			const [forum,thread]: unknown[] = await Promise.all([forumResponse.json(),threadResponse.json()]);
			if (!isRecord(forum) || forum.id !== user.forumChannelId || forum.type !== 15 || forum.guild_id !== env.DISCORD_GUILD_ID)
				throw new EditError('Your configured channel is not a Forum in this server. Check the Forum mapping.');
			if (!isRecord(thread) || thread.id !== row.discord_thread_id || thread.type !== 11 || thread.parent_id !== user.forumChannelId ||
				thread.guild_id !== env.DISCORD_GUILD_ID || typeof thread.name !== 'string' || !isRecord(thread.thread_metadata) ||
				typeof thread.thread_metadata.archived !== 'boolean' || typeof thread.thread_metadata.locked !== 'boolean')
				throw new EditError('The saved post is not a valid thread in your Forum. Check its database link.');
			const metadata = { archived:thread.thread_metadata.archived, locked:thread.thread_metadata.locked };
			const saved = await db.prepare(`UPDATE application_edits SET thread_metadata = ? WHERE id = ? AND state = 'pending'
				AND EXISTS (SELECT 1 FROM applications a WHERE a.id = application_edits.application_id AND a.owner_discord_id = ? AND a.status_change_id = ?)`)
				.bind(JSON.stringify({...metadata,name:thread.name}),id,owner,id).run();
			if (saved.meta.changes !== 1) throw new EditError('Database could not record the original post state. Check the application before retrying.');
			stage = 'rename'; mutating = true;
			await request(`/channels/${row.discord_thread_id}`,'PATCH',{ name:applicationTitle(input.details), archived:false, ...(metadata.locked?{locked:false}:{}) });
			stage = 'starter_update';
			await request(`/channels/${row.discord_thread_id}/messages/${row.discord_thread_id}`,'PATCH',{
				embeds:[applicationEmbed({...input.details,id:row.id},row.applied_at,row.status)],allowed_mentions:noMentions,
			});
			if (metadata.archived || metadata.locked) {
				stage = 'restore'; await request(`/channels/${row.discord_thread_id}`,'PATCH',metadata);
			}
		}
		stage = 'database_commit';
		const committed = await db.batch([
			db.prepare(`UPDATE application_edits SET state = 'complete', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND state = 'pending'
				AND EXISTS (SELECT 1 FROM applications a WHERE a.id = application_edits.application_id AND a.owner_discord_id = ?
				AND a.forum_channel_id = ? AND a.status_change_id = ? AND a.details_version = ? AND a.status = ?)`)
				.bind(id,owner,user.forumChannelId,id,row.base_version,row.status),
			db.prepare(`UPDATE applications SET company = ?, position = ?, job_url = ?, notes = ?, details_version = details_version + ?, status_change_id = NULL,
				updated_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE updated_at END
				WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ? AND status_change_id = ? AND details_version = ? AND status = ?
				AND EXISTS (SELECT 1 FROM application_edits WHERE id = ? AND application_id = ? AND state = 'complete')`)
				.bind(input.details.company,input.details.position,input.details.jobUrl,input.details.notes,changed?1:0,changed?1:0,
					row.id,owner,user.forumChannelId,id,row.base_version,row.status,id,row.id),
		]);
		if (committed.some(result => result.meta.changes !== 1)) throw new Error('Commit did not match claim');
		return changed ? `Application updated. ${link}` : `No changes to save. ${link}`;
	} catch (error) {
		try {
			const statements = [db.prepare(`UPDATE application_edits SET state = ?, failure_stage = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
				WHERE id = ? AND state = 'pending' AND EXISTS (SELECT 1 FROM applications a WHERE a.id = application_edits.application_id
				AND a.owner_discord_id = ? AND a.status_change_id = ?)`)
				.bind(mutating?'needs_check':'failed',stage,id,owner,id)];
			if (!mutating) statements.push(db.prepare(`UPDATE applications SET status_change_id = NULL WHERE id = ? AND owner_discord_id = ? AND status_change_id = ?
				AND EXISTS (SELECT 1 FROM application_edits WHERE id = ? AND application_id = ? AND state = 'failed')`).bind(row.id,owner,id,id,row.id));
			await db.batch(statements);
		} catch { return `The edit needs database checking. Do not repeat it. ${link} Reference: ${id}.`; }
		if (mutating) return `The edit did not fully complete; Discord may be partly updated. Do not repeat it until checked. ${link} Reference: ${id}.`;
		return error instanceof EditError ? error.message : 'Could not read your Forum post. Check bot access, then run /edit again.';
	}
}

export async function completeEdit(input: EditInput, user: UserForum, token: string, env: Env): Promise<void> {
	let content: string;
	try { content = await saveEdit(input,user,env); }
	catch { content = checking(input.formId); }
	await editPrivateReply(content,token,env,'edit',3000);
}
