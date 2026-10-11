import { isDiscordId, isRecord, type ApplicationInput } from './apply-form';
import { applicationEmbed } from './application-embed';
import type { UserForum } from './authorization';
import { discordRequest, editPrivateReply, noMentions } from './discord';
import { isStatus, type StatusInput } from './status-form';

interface ApplicationRow {
	id: string; company: string; position: string; job_url: string | null; notes: string | null;
	applied_at: string; status: string; discord_thread_id: string | null; status_change_id: string | null; details_version: number;
}
class StatusError extends Error {}
const checking = (id: string) => `A status change is processing or needs checking. Do not repeat it until checked. Reference: ${id}.`;

export async function changeStatus(input: StatusInput, user: UserForum, id: string, env: Env): Promise<string> {
	const db = env.disc_tracker_db;
	const owner = user.ownerDiscordId;
	const app = input.applicationId;
	const rejected = async (stage: 'busy' | 'claim_lost') => {
		// Retain rejected interaction IDs too, so late redelivery cannot undo newer changes.
		await db.prepare(`INSERT INTO status_changes (id, application_id, from_status, to_status, state, failure_stage)
			SELECT ?, id, status, ?, 'failed', ? FROM applications
			WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ? ON CONFLICT(id) DO NOTHING`)
			.bind(id, input.status, stage, app, owner, user.forumChannelId).run();
		const latest = await db.prepare(`SELECT status_change_id FROM applications WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ?`)
			.bind(app, owner, user.forumChannelId).first<{ status_change_id: string | null }>();
		return latest?.status_change_id ? checking(latest.status_change_id) : 'This attempt did not complete. Check the application, then run /status again.';
	};
	let row: ApplicationRow | null;
	try {
		row = await db.prepare(`SELECT * FROM applications WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ?`)
			.bind(app, owner, user.forumChannelId).first<ApplicationRow>();
		if (!row || !isDiscordId(row.discord_thread_id) || !isStatus(row.status)) return 'That application is unavailable. Choose one of your saved applications.';
		const previous = await db.prepare(`SELECT c.application_id, c.to_status, c.state FROM status_changes c
			JOIN applications a ON a.id = c.application_id WHERE c.id = ? AND a.owner_discord_id = ?`)
			.bind(id, owner).first<{ application_id: string; to_status: string; state: string }>();
		if (previous) {
			if (previous.application_id !== app || previous.to_status !== input.status) return 'Invalid status request. Run /status again.';
			if (previous.state === 'complete') return `This request was already completed — ${previous.to_status}. Current status: ${row.status}.`;
			if (previous.state === 'failed') return 'This attempt did not complete. Check the application, then run /status again.';
			return checking(id);
		}
		if (row.status_change_id) return await rejected('busy');
		const claimed = await db.batch([
			db.prepare(`INSERT INTO status_changes (id, application_id, from_status, to_status)
				SELECT ?, id, status, ? FROM applications WHERE id = ? AND owner_discord_id = ? AND forum_channel_id = ?
				AND status = ? AND discord_thread_id = ? AND details_version = ? AND status_change_id IS NULL ON CONFLICT(id) DO NOTHING`)
				.bind(id, input.status, app, owner, user.forumChannelId, row.status, row.discord_thread_id, row.details_version),
			db.prepare(`UPDATE applications SET status_change_id = ? WHERE id = ? AND owner_discord_id = ?
				AND forum_channel_id = ? AND status = ? AND details_version = ? AND status_change_id IS NULL
				AND EXISTS (SELECT 1 FROM status_changes WHERE id = ? AND application_id = ? AND state = 'pending')`)
				.bind(id, app, owner, user.forumChannelId, row.status, row.details_version, id, app),
		]);
		if (claimed.some(result => result.meta.changes !== 1)) return await rejected('claim_lost');
	} catch { return 'Database could not start this change. Check the D1 migration and application before retrying.'; }

	const threadId = row.discord_thread_id!;
	const link = `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${threadId}`;
	let stage = 'preflight';
	let mutating = false;
	let historyId: string | null = null;
	try {
		if (row.status !== input.status) {
			const request = async (path: string, method = 'GET', body?: unknown) => {
				const response = await discordRequest(path, env.DISCORD_TOKEN, method, body, 3000);
				if (!response.ok) throw new StatusError(`Discord could not finish ${stage.replaceAll('_',' ')} (HTTP ${response.status}). Check bot access and permissions.`);
				return response;
			};
			const [forumResponse, threadResponse] = await Promise.all([
				request(`/channels/${user.forumChannelId}`), request(`/channels/${threadId}`),
			]);
			const [forum, thread]: unknown[] = await Promise.all([forumResponse.json(), threadResponse.json()]);
			if (!isRecord(forum) || forum.id !== user.forumChannelId || forum.type !== 15 || forum.guild_id !== env.DISCORD_GUILD_ID || !Array.isArray(forum.available_tags))
				throw new StatusError('Your configured channel is not a Forum in this server. Check the Forum mapping.');
			if (!isRecord(thread) || thread.id !== threadId || thread.type !== 11 || thread.parent_id !== user.forumChannelId || thread.guild_id !== env.DISCORD_GUILD_ID ||
				!Array.isArray(thread.applied_tags) || !thread.applied_tags.every(isDiscordId) || !isRecord(thread.thread_metadata) ||
				typeof thread.thread_metadata.archived !== 'boolean' || typeof thread.thread_metadata.locked !== 'boolean')
				throw new StatusError('The saved post is not a valid thread in your Forum. Check its database link.');
			const tags = forum.available_tags.filter(tag => isRecord(tag) && isDiscordId(tag.id) && isStatus(tag.name));
			const targets = tags.filter(tag => tag.name === input.status);
			if (targets.length !== 1) throw new StatusError(`Your Forum needs exactly one tag named ${input.status}. Add or correct it, then try again.`);
			const statusIds = new Set(tags.map(tag => tag.id));
			const nextTags = [...new Set(thread.applied_tags.filter(tag => !statusIds.has(tag))), targets[0].id];
			if (nextTags.length > 5) throw new StatusError('This post has too many other tags. Keep at most four non-status tags, then try again.');
			const metadata = thread.thread_metadata;
			stage = 'tag_update'; mutating = true;
			await request(`/channels/${threadId}`, 'PATCH', { applied_tags: nextTags, archived: false, ...(metadata.locked ? { locked: false } : {}) });
			stage = 'starter_update';
			const embedInput: ApplicationInput = { id: app, company: row.company, position: row.position, jobUrl: row.job_url, notes: row.notes };
			// Forum starter messages have the same ID as their thread.
			await request(`/channels/${threadId}/messages/${threadId}`, 'PATCH', { embeds: [applicationEmbed(embedInput,row.applied_at,input.status)], allowed_mentions: noMentions });
			stage = 'history_write';
			const history: unknown = await (await request(`/channels/${threadId}/messages`, 'POST', {
				content: `${row.status} → ${input.status}`, allowed_mentions: noMentions, nonce: id, enforce_nonce: true,
			})).json();
			if (!isRecord(history) || !isDiscordId(history.id)) throw new StatusError('Discord history could not be confirmed.');
			historyId = history.id;
			if (metadata.archived || metadata.locked) {
				stage = 'restore';
				await request(`/channels/${threadId}`, 'PATCH', { archived: metadata.archived, locked: metadata.locked });
			}
		}
		stage = 'database_commit';
		const committed = await db.batch([
			db.prepare(`UPDATE status_changes SET state = 'complete', history_message_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
				WHERE id = ? AND application_id = ? AND state = 'pending'
				AND EXISTS (SELECT 1 FROM applications WHERE id = ? AND owner_discord_id = ? AND status_change_id = ? AND status = ?)`)
				.bind(historyId, id, app, app, owner, id, row.status),
			db.prepare(`UPDATE applications SET status = ?, status_change_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
				WHERE id = ? AND owner_discord_id = ? AND status_change_id = ? AND status = ?
				AND EXISTS (SELECT 1 FROM status_changes WHERE id = ? AND application_id = ? AND state = 'complete')`)
				.bind(input.status, app, owner, id, row.status, id, app),
		]);
		if (committed.some(result => result.meta.changes !== 1)) throw new Error('Commit did not match claim');
		return row.status === input.status ? `Already ${input.status}. No new history was added. ${link}` : `Status updated — ${input.status}. ${link}`;
	} catch (error) {
		try {
			const statements = [db.prepare(`UPDATE status_changes SET state = ?, failure_stage = ?, history_message_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
				WHERE id = ? AND application_id = ? AND state = 'pending'
				AND EXISTS (SELECT 1 FROM applications WHERE id = ? AND owner_discord_id = ? AND status_change_id = ?)`)
				.bind(mutating ? 'needs_check' : 'failed', stage, historyId, id, app, app, owner, id)];
			if (!mutating) statements.push(db.prepare(`UPDATE applications SET status_change_id = NULL WHERE id = ? AND owner_discord_id = ? AND status_change_id = ?
				AND EXISTS (SELECT 1 FROM status_changes WHERE id = ? AND application_id = ? AND state = 'failed')`).bind(app,owner,id,id,app));
			await db.batch(statements);
		} catch { return `The status change needs database checking. Do not repeat it. ${link} Reference: ${id}.`; }
		if (mutating) return `The change did not fully complete; Discord may be partly updated. Do not repeat it until checked. ${link} Reference: ${id}.`;
		return error instanceof StatusError ? error.message : 'Could not read your Forum post. Check bot access, then run /status again.';
	}
}

export async function completeStatus(input: StatusInput, user: UserForum, id: string, token: string, env: Env): Promise<void> {
	let content: string;
	try { content = await changeStatus(input,user,id,env); }
	catch { content = checking(id); }
	await editPrivateReply(content,token,env,'status',3000);
}
