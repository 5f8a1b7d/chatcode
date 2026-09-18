import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { createAuthorizedStudyBuddyClient } from '../backend/connection';
import type { SystemSelectionSnapshot } from '../editor/selection';
import { projectIdForSystemSelection } from '../learning/explanationController';

interface SearchMemoriesInput {
	query: string;
}

interface SearchNotesInput {
	query: string;
}

interface SaveMemoryInput {
	sourceText: string;
	explanation: string;
}

interface ExplainMaterialInput {
	material: string;
	question: string;
}

/** Registers Study Buddy learning tools for the chat and Agent Host harnesses. */
export function registerStudyBuddyTools(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.lm.registerTool<SearchNotesInput>('studybuddy_search_notes', {
		async invoke(options, token) {
			const query = requiredText(options.input.query, 200).toLocaleLowerCase();
			const files = await vscode.workspace.findFiles('**/*.{md,markdown}', '**/{node_modules,.git,out,dist}/**', 201, token);
			const matches: Array<{ uri: string; line: number; excerpt: string }> = [];
			let skippedLargeFiles = 0;
			let skippedUnreadableFiles = 0;
			for (const uri of files.slice(0, 200)) {
				if (token.isCancellationRequested || matches.length >= 10) {
					break;
				}
				let document: vscode.TextDocument;
				try {
					document = await vscode.workspace.openTextDocument(uri);
				} catch {
					if (token.isCancellationRequested) {
						throw new vscode.CancellationError();
					}
					skippedUnreadableFiles++;
					continue;
				}
				const content = document.getText();
				if (content.length > 1_000_000) {
					skippedLargeFiles++;
					continue;
				}
				const index = content.toLocaleLowerCase().indexOf(query);
				if (index < 0) {
					continue;
				}
				matches.push({
					uri: uri.toString(),
					line: document.positionAt(index).line + 1,
					excerpt: content.slice(Math.max(0, index - 200), Math.min(content.length, index + query.length + 300)),
				});
			}
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			return textResult(JSON.stringify({ matches, limitedToFirst200Files: files.length > 200, limitedToFirst10Matches: matches.length === 10, skippedLargeFiles, skippedUnreadableFiles }));
		},
		prepareInvocation: options => ({ invocationMessage: vscode.l10n.t('Searching study notes for {0}', options.input.query) }),
	}));

	context.subscriptions.push(vscode.lm.registerTool<SearchMemoriesInput>('studybuddy_search_memories', {
		async invoke(options, token) {
			const query = requiredText(options.input.query, 500);
			const client = await createAuthorizedStudyBuddyClient(context);
			const memories = await client.searchMemories(projectIdForSystemSelection(), query, token);
			return textResult(JSON.stringify({ memories: memories.map(memory => ({
				memoryId: memory.memoryId,
				createdAt: memory.createdAt,
				source: memory.source,
				selectedTextExcerpt: memory.selectedText.slice(0, 1_000),
				explanationExcerpt: memory.explanation.slice(0, 1_000),
				truncated: memory.selectedText.length > 1_000 || memory.explanation.length > 1_000,
			})) }));
		},
		prepareInvocation: options => ({
			invocationMessage: vscode.l10n.t('Searching Study Buddy memories for {0}', options.input.query),
		}),
	}));

	context.subscriptions.push(vscode.lm.registerTool<SaveMemoryInput>('studybuddy_save_memory', {
		async invoke(options, token) {
			const sourceText = requiredText(options.input.sourceText, 200_000);
			const explanation = requiredText(options.input.explanation, 200_000);
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const requestId = `studybuddy-agent-${randomUUID()}`;
			const client = await createAuthorizedStudyBuddyClient(context);
			const receipt = await client.saveMemory(requestId, snapshot(requestId, sourceText), explanation);
			return textResult(JSON.stringify({ memoryId: receipt.memoryId, persistedAt: receipt.persistedAt }));
		},
		prepareInvocation: () => ({
			invocationMessage: vscode.l10n.t('Saving Study Buddy memory'),
			confirmationMessages: {
				title: vscode.l10n.t('Save Learning Memory'),
				message: vscode.l10n.t('Save this learning note to the current Study Buddy project?'),
			},
		}),
	}));

	context.subscriptions.push(vscode.lm.registerTool<ExplainMaterialInput>('studybuddy_explain_material', {
		async invoke(options, token) {
			const material = requiredText(options.input.material, 1_500_000);
			const question = requiredText(options.input.question, 12_000);
			const requestId = `studybuddy-agent-${randomUUID()}`;
			const client = await createAuthorizedStudyBuddyClient(context);
			const result = await client.explain(requestId, question, snapshot(requestId, material), token, () => { });
			return textResult(result.text);
		},
		prepareInvocation: () => ({ invocationMessage: vscode.l10n.t('Explaining material with Study Buddy') }),
	}));
}

function snapshot(requestId: string, text: string): SystemSelectionSnapshot {
	return {
		kind: 'system',
		selectionId: requestId,
		text,
		projectId: projectIdForSystemSelection(),
		capturedAt: Date.now(),
		application: 'Study Buddy Agent',
	};
}

function requiredText(value: string, maxLength: number): string {
	if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
		throw new Error(vscode.l10n.t('Study Buddy tool input must contain text within the supported length.'));
	}
	return value.trim();
}

function textResult(value: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
}
