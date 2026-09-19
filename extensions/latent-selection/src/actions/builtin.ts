import * as vscode from 'vscode';
import type { ISelectionActionContext, ISelectionActionDescriptor, ISelectionSnapshot, ProviderCapability } from '../api';
import { languageDisplayName, resolveTargetLanguage, translationPrompt } from '../selection/snapshot';

const providerExtensionId = 'latentnote.latent-provider';
const targetLanguageSetting = 'latent.selection.translate.targetLanguage';

/** Subset of the Provider extension API used here (spec 02 §4). */
interface IProviderApi {
	resolve(request: { capability: ProviderCapability; requires?: { streaming?: boolean } }): Promise<{ providerName: string; modelName: string; modelId: string }>;
	guide(capability: ProviderCapability, caller: string): Promise<void>;
	text(binding: unknown, options: { messages: readonly vscode.LanguageModelChatMessage[] }, token: vscode.CancellationToken): AsyncIterable<vscode.LanguageModelResponsePart>;
}

async function providerApi(): Promise<IProviderApi | undefined> {
	const extension = vscode.extensions.getExtension<IProviderApi>(providerExtensionId);
	if (!extension) {
		return undefined;
	}
	return extension.isActive ? extension.exports : extension.activate();
}

/** Streams a text-generation result into the bar and appends the generic explanation for More details (P2-FR-013). */
async function streamToBar(context: ISelectionActionContext, caller: string, instruction: string, extraDetails: string[] = []): Promise<void> {
	const api = await providerApi();
	if (!api) {
		context.bar.report({ phase: 'failed', text: vscode.l10n.t('The Latent Provider extension is not available. Install or enable it to use {0}.', caller) });
		return;
	}
	let binding: { providerName: string; modelName: string; modelId: string };
	try {
		binding = await api.resolve({ capability: 'text', requires: { streaming: true } });
	} catch (error) {
		context.bar.report({ phase: 'failed', text: vscode.l10n.t('{0} needs a text provider. Configure one in Latent: Manage Providers.', caller), details: error instanceof Error ? error.message : String(error) });
		void api.guide('text', caller);
		return;
	}
	context.bar.report({ phase: 'running' });
	const started = Date.now();
	let text = '';
	try {
		for await (const part of api.text(binding, { messages: [vscode.LanguageModelChatMessage.User(`${instruction}\n\n${context.selection.text}`)] }, context.token)) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
				context.bar.report({ phase: 'running', text });
			}
		}
	} catch (error) {
		context.bar.report({ phase: 'failed', text: error instanceof Error ? error.message : String(error) });
		return;
	}
	const details = [
		vscode.l10n.t('Provider: {0}', binding.providerName),
		vscode.l10n.t('Model: {0}', binding.modelName || binding.modelId),
		vscode.l10n.t('Source: {0}', context.selection.source),
		vscode.l10n.t('Selection length: {0} characters{1}', context.selection.text.length, context.selection.truncated ? ` (${vscode.l10n.t('truncated')})` : ''),
		vscode.l10n.t('Elapsed: {0} ms', Date.now() - started),
		...extraDetails,
	].join('\n');
	context.bar.report({ phase: 'succeeded', text, details });
}

export async function resolveTranslateTarget(): Promise<string> {
	const configured = vscode.workspace.getConfiguration().get<string>(targetLanguageSetting);
	let osLocale: string | undefined;
	try {
		osLocale = await vscode.commands.executeCommand<string>('_latent.platform.osLocale');
	} catch {
		// Stock VS Code host: fall back to the extension host's Intl locale.
	}
	return resolveTargetLanguage(configured, osLocale, Intl.DateTimeFormat().resolvedOptions().locale);
}

export function builtinActions(): ISelectionActionDescriptor[] {
	return [
		{
			id: 'latent.selection.explain',
			title: vscode.l10n.t('Explain'),
			icon: 'lightbulb',
			order: 10,
			requires: ['text'],
			showsResult: true,
			run: context => streamToBar(context, vscode.l10n.t('Explain'), 'Explain the selected text clearly and concisely. Reply in the language used by the selection.'),
		},
		{
			id: 'latent.selection.translate',
			title: vscode.l10n.t('Translate'),
			icon: 'globe',
			order: 20,
			requires: ['text'],
			showsResult: true,
			run: async context => {
				const target = await resolveTranslateTarget();
				await streamToBar(context, vscode.l10n.t('Translate'), translationPrompt(target), [vscode.l10n.t('Translated to {0} ({1})', languageDisplayName(target), target)]);
			},
		},
		{
			id: 'latent.selection.summarize',
			title: vscode.l10n.t('Summarize'),
			icon: 'list-flat',
			order: 30,
			requires: ['text'],
			showsResult: true,
			run: context => streamToBar(context, vscode.l10n.t('Summarize'), 'Summarize the selected text concisely. Preserve its key claims and qualifications. Reply in the language used by the selection.'),
		},
	];
}

export function snapshotFromActiveEditor(): ISelectionSnapshot | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.selection.isEmpty) {
		return undefined;
	}
	const text = editor.document.getText(editor.selection);
	if (!text.trim()) {
		return undefined;
	}
	return {
		selectionId: `command-${Date.now()}`,
		source: 'editor',
		text,
		capturedAt: Date.now(),
		editable: true,
		uri: editor.document.uri.toString(true),
		languageId: editor.document.languageId,
		range: { start: { line: editor.selection.start.line, character: editor.selection.start.character }, end: { line: editor.selection.end.line, character: editor.selection.end.character } },
	};
}
