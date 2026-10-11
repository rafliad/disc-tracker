import { applyModal, isDiscordId, isRecord, parseApplication, type ApplicationInput } from './apply-form';

export interface EditInput { formId: string; details: ApplicationInput }
export function parseEditOptions(data: unknown): string | null {
	if (!isRecord(data) || !Array.isArray(data.options) || data.options.length !== 1) return null;
	const option = data.options[0];
	return isRecord(option) && option.type === 3 && option.name === 'application' && option.focused !== true && isDiscordId(option.value)
		? option.value : null;
}

export function editModal(id: string, owner: string, details: ApplicationInput) {
	const modal = applyModal(id, owner);
	modal.data.custom_id = `edit:${id}:${owner}`;
	modal.data.title = 'Edit job application';
	const values: Record<string, string> = { company: details.company, position: details.position, job_url: details.jobUrl ?? '', notes: details.notes ?? '' };
	return { ...modal, data: { ...modal.data, components: modal.data.components.map(label => ({ ...label, component: { ...label.component, value: values[label.component.custom_id] } })) } };
}

export function parseEdit(data: unknown, owner: string): { value: EditInput } | { error: string } {
	if (!isRecord(data) || typeof data.custom_id !== 'string' || !Array.isArray(data.components) || data.components.length !== 4)
		return { error: 'Invalid edit form. Run /edit again.' };
	const match = /^edit:([1-9]\d{16,19}):([1-9]\d{16,19})$/.exec(data.custom_id);
	if (!match || match[2] !== owner) return { error: 'This edit form does not belong to you. Run /edit again.' };
	const parsed = parseApplication({ ...data, custom_id: `apply:${match[1]}:${owner}` }, owner);
	if ('error' in parsed) return { error: parsed.error.replaceAll('/apply', '/edit') };
	return { value: { formId: match[1], details: parsed.value } };
}
