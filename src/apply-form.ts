export interface ApplicationInput {
	id: string;
	company: string;
	position: string;
	jobUrl: string | null;
	notes: string | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isDiscordId(value: unknown): value is string {
	return typeof value === 'string' && /^[1-9]\d{16,19}$/.test(value);
}

export function applyModal(id: string, ownerId: string) {
	const input = (customId: string, label: string, required: boolean, maxLength: number, style = 1) => ({
		type: 18, label,
		component: { type: 4, custom_id: customId, style, required, max_length: maxLength },
	});
	return {
		type: 9,
		data: {
			custom_id: `apply:${id}:${ownerId}`, title: 'Track a job application',
			components: [
				input('company', 'Company', true, 100),
				input('position', 'Position', true, 100),
				input('job_url', 'Job URL (optional)', false, 1000),
				input('notes', 'Notes (optional)', false, 2000, 2),
			],
		},
	};
}

export function parseApplication(data: unknown, ownerId: string): { value: ApplicationInput } | { error: string } {
	if (!isRecord(data) || typeof data.custom_id !== 'string') return { error: 'Invalid application form. Run /apply again.' };
	const match = /^apply:([1-9]\d{16,19}):([1-9]\d{16,19})$/.exec(data.custom_id);
	if (!match || match[2] !== ownerId) return { error: 'This application form does not belong to you. Run /apply again.' };
	if (!Array.isArray(data.components) || data.components.length > 4) return { error: 'Invalid application form. Run /apply again.' };
	const values: Record<string, string> = {};
	for (const label of data.components) {
		if (!isRecord(label) || label.type !== 18 || !isRecord(label.component)) return { error: 'Invalid application form. Run /apply again.' };
		const field = label.component;
		if (field.type !== 4 || typeof field.custom_id !== 'string' || typeof field.value !== 'string' ||
			!['company', 'position', 'job_url', 'notes'].includes(field.custom_id) || Object.hasOwn(values, field.custom_id)) {
			return { error: 'Invalid application form. Run /apply again.' };
		}
		values[field.custom_id] = field.value.trim();
	}
	const company = values.company ?? '';
	const position = values.position ?? '';
	if (!company || !position || company.length > 100 || position.length > 100 || /[\u0000-\u001f\u007f]/.test(company + position)) {
		return { error: 'Company and position are required, each on one line and up to 100 characters. Run /apply again.' };
	}
	const notes = values.notes || null;
	if (notes && notes.length > 2000) return { error: 'Notes must be at most 2000 characters. Run /apply again.' };
	let jobUrl: string | null = null;
	if (values.job_url) {
		try {
			const url = new URL(values.job_url);
			if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
				/\s/.test(values.job_url) || url.href.length > 1000) throw new Error('Invalid URL');
			jobUrl = url.href;
		} catch {
			return { error: 'Job URL must be a valid http:// or https:// address, without login credentials, up to 1000 characters. Run /apply again.' };
		}
	}
	return { value: { id: match[1], company, position, jobUrl, notes } };
}
