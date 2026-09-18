import * as vscode from 'vscode';
import { ExplanationController } from './learning/explanationController';
import { registerStudyBuddyParticipant } from './chat/participant';
import { registerStudyBuddyTools } from './chat/tools';

/**
 * Learning-domain features of Study Buddy. Provider configuration moved to the
 * `latent-provider` extension and selection handling to `latent-selection`
 * (spec 02 §6); the private plugin of spec 03 takes over the remainder.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	registerStudyBuddyParticipant(context);
	registerStudyBuddyTools(context);
	context.subscriptions.push(new ExplanationController(context));
}
