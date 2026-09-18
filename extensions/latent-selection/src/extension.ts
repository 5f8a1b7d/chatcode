import * as vscode from 'vscode';
import type { IAddToNoteHandler, ILatentSelectionApi, ISelectionActionDescriptor } from './api';
import { builtinActions, snapshotFromActiveEditor } from './actions/builtin';
import { SelectionActionRegistry } from './actions/registry';
import { registerAskInSideChatPlugin } from './plugins/askInSideChat';
import { isSelectionActionEvent } from './selection/snapshot';

const runCommand = 'latent.selection.runAction';
const systemEnabledSetting = 'latent.selection.system.enabled';
const legacySystemEnabledSetting = 'latentnote.studyBuddy.globalSelection.enabled';
const setEnabledCommand = '_latent.selection.setEnabled';
const setPinnedCommand = '_latent.selection.setPinned';
const settingsMigratedKey = 'latent.selection.settingsMigrated';

interface IContributedAction {
	id: string;
	title: string;
	icon?: string;
	order?: number;
	when?: string;
	showsResult?: boolean;
	command: string;
}

export async function activate(context: vscode.ExtensionContext): Promise<ILatentSelectionApi> {
	const registry = new SelectionActionRegistry(`extension:${context.extension.id}`, runCommand);
	context.subscriptions.push(registry);

	const api: ILatentSelectionApi = {
		version: 1,
		registerSelectionAction: descriptor => registry.register(descriptor),
		registerAddToNoteHandler: (handler: IAddToNoteHandler) => registerNoteHandler(registry, handler),
		onDidRunAction: registry.onDidRunAction,
		pin: async pinned => {
			try {
				await vscode.commands.executeCommand(setPinnedCommand, pinned);
			} catch {
				// Stock VS Code has no selection bar to pin.
			}
		},
	};

	for (const descriptor of builtinActions()) {
		context.subscriptions.push(registry.register(descriptor));
	}
	context.subscriptions.push(registerAskInSideChatPlugin(api));
	context.subscriptions.push(registerContributedActions(registry));
	context.subscriptions.push(vscode.extensions.onDidChange(() => context.subscriptions.push(registerContributedActions(registry))));

	context.subscriptions.push(vscode.commands.registerCommand(runCommand, async (event: unknown) => {
		if (!isSelectionActionEvent(event)) {
			throw new Error('Invalid selection action event');
		}
		await registry.run(event);
	}));
	// The workbench routes unknown action ids here for Study Buddy compatibility.
	context.subscriptions.push(vscode.commands.registerCommand('latentnote.studyBuddy.handleSystemSelectionAction', async (event: unknown) => {
		if (isSelectionActionEvent(event) && registry.get(event.action)) {
			await registry.run(event);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('latent.selection.pin', () => api.pin(true)));
	context.subscriptions.push(vscode.commands.registerCommand('latent.selection.unpin', () => api.pin(false)));
	for (const [command, action] of [['latent.selection.explainActive', 'latent.selection.explain'], ['latent.selection.translateActive', 'latent.selection.translate'], ['latent.selection.summarizeActive', 'latent.selection.summarize']] as const) {
		context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
			const selection = snapshotFromActiveEditor();
			if (!selection) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Select text in an editor first.'));
				return;
			}
			await runInProgress(registry, action, selection);
		}));
	}

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(systemEnabledSetting) || event.affectsConfiguration(legacySystemEnabledSetting)) {
			void syncSystemSelectionEnabled();
		}
	}));
	await migrateSettings(context);
	await registry.publish();
	await syncSystemSelectionEnabled();
	return api;
}

export function deactivate(): void {
	void vscode.commands.executeCommand(setEnabledCommand, false).then(undefined, () => undefined);
}

function registerNoteHandler(registry: SelectionActionRegistry, handler: IAddToNoteHandler): vscode.Disposable {
	const handlerRegistration = registry.registerAddToNoteHandler(handler);
	const action: ISelectionActionDescriptor = {
		id: 'latent.selection.addToNote',
		title: vscode.l10n.t('Add to Note'),
		icon: 'notebook',
		order: 80,
		run: context => registry.runAddToNote(context.selection),
	};
	const actionRegistration = registry.get(action.id) ? new vscode.Disposable(() => undefined) : registry.register(action);
	return new vscode.Disposable(() => {
		handlerRegistration.dispose();
		if (!registry.hasNoteHandlers()) {
			actionRegistration.dispose();
		}
	});
}

/** Declarative `latentSelectionActions` contributions from other extensions (spec 02 §4). */
function registerContributedActions(registry: SelectionActionRegistry): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];
	for (const extension of vscode.extensions.all) {
		const contributed = (extension.packageJSON as { contributes?: { latentSelectionActions?: IContributedAction[] } }).contributes?.latentSelectionActions;
		if (!Array.isArray(contributed)) {
			continue;
		}
		for (const action of contributed) {
			if (typeof action?.id !== 'string' || typeof action.title !== 'string' || typeof action.command !== 'string' || registry.get(action.id)) {
				continue;
			}
			disposables.push(registry.register({
				id: action.id,
				title: action.title,
				icon: action.icon,
				order: typeof action.order === 'number' ? action.order : 100,
				when: action.when,
				showsResult: action.showsResult === true,
				run: async context => {
					await vscode.commands.executeCommand(action.command, context.selection);
					context.bar.report({ phase: 'succeeded' });
				},
			}));
		}
	}
	return vscode.Disposable.from(...disposables);
}

async function runInProgress(registry: SelectionActionRegistry, action: string, selection: Parameters<SelectionActionRegistry['run']>[0]['selection']): Promise<void> {
	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Latent Selection') }, async progress => {
		const descriptor = registry.get(action);
		if (!descriptor) {
			return;
		}
		let last = '';
		const source = new vscode.CancellationTokenSource();
		try {
			await descriptor.run({
				selection,
				token: source.token,
				bar: {
					report: update => {
						if (update.text && update.text !== last) {
							last = update.text;
							progress.report({ message: update.text.slice(0, 120) });
						}
						if (update.phase === 'succeeded' && update.text) {
							void vscode.window.showInformationMessage(update.text, { modal: false });
						}
						if (update.phase === 'failed') {
							void vscode.window.showErrorMessage(update.text ?? vscode.l10n.t('The action failed.'));
						}
					},
				},
			});
		} finally {
			source.dispose();
		}
	});
}

async function migrateSettings(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(settingsMigratedKey)) {
		return;
	}
	const configuration = vscode.workspace.getConfiguration();
	const legacy = configuration.inspect<boolean>(legacySystemEnabledSetting);
	const current = configuration.inspect<boolean>(systemEnabledSetting);
	if (legacy?.globalValue !== undefined && current?.globalValue === undefined) {
		await configuration.update(systemEnabledSetting, legacy.globalValue, vscode.ConfigurationTarget.Global);
	}
	await context.globalState.update(settingsMigratedKey, true);
}

async function syncSystemSelectionEnabled(): Promise<void> {
	const configuration = vscode.workspace.getConfiguration();
	const current = configuration.inspect<boolean>(systemEnabledSetting);
	const enabled = current?.globalValue !== undefined || current?.workspaceValue !== undefined
		? configuration.get<boolean>(systemEnabledSetting, true)
		: configuration.get<boolean>(legacySystemEnabledSetting, configuration.get<boolean>(systemEnabledSetting, true));
	try {
		const active = await vscode.commands.executeCommand<boolean>(setEnabledCommand, enabled);
		if (enabled && active === false) {
			void vscode.window.showWarningMessage(vscode.l10n.t('System-wide text selection is unavailable in this build.'));
		}
	} catch {
		// Stock VS Code does not provide the Latent selection bar.
	}
}
