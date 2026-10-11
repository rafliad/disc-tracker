export interface UserForum {
	ownerDiscordId: string;
	forumChannelId: string;
}

/** Resolve the invoking guild member only. This configuration makes no Discord API calls. */
export function resolveUserForum(interaction: unknown, env: Pick<Env, 'DISCORD_GUILD_ID' | 'USER_FORUM_MAP'>): UserForum | null {
	if (typeof interaction !== 'object' || interaction === null ||
		!('guild_id' in interaction) || interaction.guild_id !== env.DISCORD_GUILD_ID ||
		!('member' in interaction)) {
		return null;
	}
	const member = interaction.member;
	if (typeof member !== 'object' || member === null || !('user' in member)) return null;
	const user = member.user;
	if (typeof user !== 'object' || user === null || !('id' in user) || typeof user.id !== 'string') return null;

	let mapping: unknown;
	try {
		mapping = JSON.parse(env.USER_FORUM_MAP);
	} catch {
		return null;
	}
	if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) return null;
	if (!Object.hasOwn(mapping, user.id)) return null;
	const forumChannelId = (mapping as Record<string, unknown>)[user.id];
	if (typeof forumChannelId !== 'string' || !/^[1-9]\d{16,19}$/.test(forumChannelId)) return null;
	return { ownerDiscordId: user.id, forumChannelId };
}
