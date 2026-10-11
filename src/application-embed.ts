import type { ApplicationInput } from './apply-form';

export function applicationEmbed(input: ApplicationInput, appliedAt: string, status = 'Applied') {
	return {
		title: `${input.company} — ${input.position}`,
		fields: [
			{ name: 'Status', value: status, inline: true },
			{ name: 'Applied date', value: appliedAt, inline: true },
			...(input.jobUrl ? [{ name: 'Job URL', value: input.jobUrl, inline: false }] : []),
		],
		...(input.notes ? { description: input.notes } : {}),
	};
}
