import { registerCommand } from './register-command.mjs';

await registerCommand('status', 'Update one of your job applications.', [
	{ type: 3, name: 'application', description: 'Your job application', required: true, autocomplete: true },
	{ type: 3, name: 'status', description: 'New application status', required: true,
		choices: ['Applied', 'Screening', 'Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn'].map(name => ({ name, value: name })) },
]);
