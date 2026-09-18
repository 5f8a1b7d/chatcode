import * as vscode from 'vscode';
import { ExplanationController } from './learning/explanationController';
import { ProviderManager } from './providers/manager';
import { CatalogLanguageModelProvider } from './providers/languageModel';
import { registerStudyBuddyParticipant } from './chat/participant';
import { registerStudyBuddyTools } from './chat/tools';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	registerStudyBuddyParticipant(context);
	registerStudyBuddyTools(context);
	context.subscriptions.push(new ExplanationController(context));
	const providers = new ProviderManager(context);
	context.subscriptions.push(providers);
	context.subscriptions.push(new CatalogLanguageModelProvider(providers, context));
	context.subscriptions.push(vscode.commands.registerCommand('latentnote.manageProviders', () => providers.open()));
	await providers.initialize();
}
