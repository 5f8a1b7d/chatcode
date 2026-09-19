import * as vscode from 'vscode';
import type { ILatentSelectionApi } from '../api';

/**
 * `Ask in Side Chat` is a plugin registered through the public extension point:
 * the bar core does not know about it (spec 02 P2-FR-030). The action only appears
 * for selections made inside a thread transcript and delegates to the workbench
 * command that applies the open-location rule.
 */
export function registerAskInSideChatPlugin(api: ILatentSelectionApi): vscode.Disposable {
	return api.registerSelectionAction({
		id: 'latent.selection.askInSideChat',
		title: vscode.l10n.t('Ask in Side Chat'),
		icon: 'comment-discussion',
		order: 40,
		when: "latent.selection.source == editor || latent.selection.source == thread",
		run: async context => {
			await vscode.commands.executeCommand('latent.selection.askInSideChat', context.selection);
		},
	});
}
