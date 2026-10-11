import { registerCommand } from './register-command.mjs';

await registerCommand('edit', 'Edit details of one of your job applications.', [
	{ type: 3, name: 'application', description: 'Your job application', required: true, autocomplete: true },
]);
