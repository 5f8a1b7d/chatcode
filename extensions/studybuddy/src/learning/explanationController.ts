import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { createSelectionSnapshot, SelectionSnapshotError, type SelectionSnapshot, type SystemSelectionSnapshot } from '../editor/selection';
import { StudyBuddyClient, StudyBuddyServiceError } from '../backend/client';
import {
	appendExplanationDelta,
	beginExplanation,
	completeExplanation,
	failExplanation,
	updateMemoryState,
	type ExplanationState,
} from './explanationState';
import { ExplanationViewProvider } from '../views/explanationView';
import { isPrivateNetworkHost } from '../utils';
import { developmentAuthorization } from './developmentAuthorization';

export const accessTokenSecret = 'latentnote.studyBuddy.accessToken';
const selectionContextKey = 'latentnote.studyBuddy.selectionContexts';
const setSystemSelectionEnabledCommand = '_latentnote.studyBuddy.systemSelection.setEnabled';
const updateSystemSelectionOverlayCommand = '_latentnote.studyBuddy.systemSelection.update';
const handleSystemSelectionActionCommand = 'latentnote.studyBuddy.handleSystemSelectionAction';

type SelectionAction = 'explain' | 'translate' | 'summarize' | 'context';

interface SystemSelectionActionEvent {
	readonly targetWindowId: number;
	readonly actionId: string;
	readonly action: SelectionAction;
	readonly selection: {
		readonly selectionId: string;
		readonly text: string;
		readonly capturedAt: number;
		readonly application?: string;
	};
}

export class ExplanationController implements vscode.Disposable {
	private readonly view: ExplanationViewProvider;
	private readonly disposables: vscode.Disposable;
	private state: ExplanationState = { phase: 'idle' };
	private cancellation: vscode.CancellationTokenSource | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.view = new ExplanationViewProvider(message => {
			switch (message.type) {
				case 'cancel': this.cancel(); break;
				case 'save': void this.addToMemory(); break;
				case 'setToken': void this.setAccessToken(); break;
			}
		});
		this.disposables = vscode.Disposable.from(
			this.view,
			vscode.window.registerWebviewViewProvider('latentnote.studyBuddy.explanation', this.view, {
				webviewOptions: { retainContextWhenHidden: true },
			}),
			vscode.commands.registerCommand('latentnote.studyBuddy.explainSelection', () => this.explainSelection()),
			vscode.commands.registerCommand('latentnote.studyBuddy.cancelExplain', () => this.cancel()),
			vscode.commands.registerCommand('latentnote.studyBuddy.addToMemory', () => this.addToMemory()),
			vscode.commands.registerCommand('latentnote.studyBuddy.setAccessToken', () => this.setAccessToken()),
			vscode.commands.registerCommand(handleSystemSelectionActionCommand, event => this.handleSystemSelectionAction(event)),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('latentnote.studyBuddy.globalSelection.enabled')) {
					void this.syncSystemSelectionEnabled();
				}
			}),
		);
		void this.updateContextKeys();
		void this.syncSystemSelectionEnabled();
	}

	dispose(): void {
		this.cancellation?.cancel();
		this.cancellation?.dispose();
		this.cancellation = undefined;
		void vscode.commands.executeCommand(setSystemSelectionEnabledCommand, false);
		this.disposables.dispose();
	}

	private async explainSelection(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Open a Markdown text editor and select text to explain.'));
			return;
		}
		let snapshot: SelectionSnapshot;
		try {
			snapshot = createSelectionSnapshot({
				text: editor.document.getText(editor.selection),
				uri: editor.document.uri.toString(true),
				projectId: projectIdFor(editor.document.uri),
				documentVersion: editor.document.version,
				languageId: editor.document.languageId,
				range: {
					start: { line: editor.selection.start.line, character: editor.selection.start.character },
					end: { line: editor.selection.end.line, character: editor.selection.end.character },
				},
			});
		} catch (error) {
			void vscode.window.showWarningMessage(selectionErrorMessage(error));
			return;
		}

		await this.executeSelectionAction('explain', snapshot, true);
	}

	private async handleSystemSelectionAction(value: unknown): Promise<void> {
		if (!isSystemSelectionActionEvent(value)) {
			return;
		}
		const snapshot: SystemSelectionSnapshot = Object.freeze({
			kind: 'system',
			selectionId: value.selection.selectionId,
			text: value.selection.text,
			capturedAt: value.selection.capturedAt,
			projectId: projectIdForSystemSelection(),
			...(value.selection.application ? { application: value.selection.application } : {}),
		});
		if (value.action === 'context') {
			await this.addSelectionContext(snapshot, value.actionId);
			return;
		}
		await this.executeSelectionAction(value.action, snapshot, false, value.actionId);
	}

	private async executeSelectionAction(action: Exclude<SelectionAction, 'context'>, snapshot: SelectionSnapshot, revealView: boolean, overlayActionId?: string): Promise<void> {
		const requestId = `code-oss-${randomUUID()}`;
		this.cancellation?.cancel();
		this.cancellation?.dispose();
		const cancellation = new vscode.CancellationTokenSource();
		this.cancellation = cancellation;
		this.setState(beginExplanation(requestId, snapshot));
		if (revealView) {
			await vscode.commands.executeCommand('workbench.view.extension.latentnoteStudyBuddy');
		}
		await this.updateSystemSelectionOverlay(snapshot, overlayActionId, action, 'running');
		const authorization = await this.authorization();
		if (!authorization) {
			const message = vscode.l10n.t('An access token is required.');
			this.updateRequest(requestId, state => failExplanation(state, message));
			await this.updateSystemSelectionOverlay(snapshot, overlayActionId, action, 'failed', message);
			cancellation.dispose();
			if (this.cancellation === cancellation) {
				this.cancellation = undefined;
			}
			return;
		}
		try {
			const prompt = this.actionPrompt(action);
			const result = await this.client(authorization).explain(
				requestId,
				this.withSelectionContexts(prompt, snapshot),
				snapshot,
				cancellation.token,
				delta => {
					this.updateRequest(requestId, state => appendExplanationDelta(state, delta));
					void this.updateSystemSelectionOverlay(snapshot, overlayActionId, action, 'running', this.currentRequestText(requestId));
				},
			);
			this.updateRequest(requestId, state => completeExplanation(state, result.text, result.traceId, result.modelDecisionId));
			await this.updateSystemSelectionOverlay(snapshot, overlayActionId, action, 'succeeded', result.text);
		} catch (error) {
			if (error instanceof vscode.CancellationError) {
				const message = vscode.l10n.t('The selection action was cancelled.');
				this.updateRequest(requestId, state => failExplanation(state, message, 'cancelled'));
				await this.updateSystemSelectionOverlay(snapshot, overlayActionId, action, 'failed', message);
			} else {
				const message = error instanceof Error ? error.message : String(error);
				this.updateRequest(requestId, state => failExplanation(state, message));
				await this.updateSystemSelectionOverlay(snapshot, overlayActionId, action, 'failed', message);
			}
		} finally {
			cancellation.dispose();
			if (this.cancellation === cancellation) {
				this.cancellation = undefined;
			}
		}
	}

	private actionPrompt(action: Exclude<SelectionAction, 'context'>): string {
		switch (action) {
			case 'explain':
				return vscode.l10n.t('Explain the selected text clearly and concisely. Reply in the language used by the selection.');
			case 'translate':
				return vscode.l10n.t('Translate the selected text into Simplified Chinese. Preserve meaning, terminology, and paragraph structure. Return only the translation.');
			case 'summarize':
				return vscode.l10n.t('Summarize the selected text concisely. Preserve its key claims and qualifications. Reply in the language used by the selection.');
		}
	}

	private withSelectionContexts(prompt: string, current: SelectionSnapshot): string {
		const contexts = this.selectionContexts().filter(context => context.selectionId !== (current.kind === 'system' ? current.selectionId : undefined));
		if (contexts.length === 0) {
			return prompt;
		}
		const rendered = contexts.slice(-10).map((context, index) => {
			const source = context.application ? ` (${context.application})` : '';
			return `[Context ${index + 1}${source}]\n${context.text}`;
		}).join('\n\n').slice(0, 20_000);
		return `${prompt}\n\nThe user explicitly attached the following reference context. Use it only when relevant:\n\n${rendered}`;
	}

	private async addSelectionContext(snapshot: SystemSelectionSnapshot, overlayActionId: string): Promise<void> {
		const contexts = this.selectionContexts().filter(item => item.selectionId !== snapshot.selectionId);
		contexts.push(snapshot);
		await this.context.workspaceState.update(selectionContextKey, contexts.slice(-20));
		await this.updateSystemSelectionOverlay(
			snapshot,
			overlayActionId,
			'context',
			'succeeded',
			vscode.l10n.t('Added to this workspace context ({0} saved selections).', Math.min(contexts.length, 20)),
		);
	}

	private selectionContexts(): SystemSelectionSnapshot[] {
		const value = this.context.workspaceState.get<unknown>(selectionContextKey);
		return Array.isArray(value) ? value.filter(isSystemSelectionSnapshot) : [];
	}

	private currentRequestText(requestId: string): string {
		return this.isCurrentRequest(requestId) && this.state.phase !== 'idle' ? this.state.text : '';
	}

	private async updateSystemSelectionOverlay(
		snapshot: SelectionSnapshot,
		actionId: string | undefined,
		action: SelectionAction,
		phase: 'running' | 'succeeded' | 'failed',
		text?: string,
	): Promise<void> {
		if (snapshot.kind !== 'system' || !actionId) {
			return;
		}
		await vscode.commands.executeCommand(updateSystemSelectionOverlayCommand, {
			selectionId: snapshot.selectionId,
			actionId,
			action,
			phase,
			...(text !== undefined ? { text } : {}),
		});
	}

	private async syncSystemSelectionEnabled(): Promise<void> {
		const enabled = vscode.workspace.getConfiguration('latentnote.studyBuddy').get<boolean>('globalSelection.enabled', true);
		try {
			const active = await vscode.commands.executeCommand<boolean>(setSystemSelectionEnabledCommand, enabled);
			if (enabled && active === false) {
				void vscode.window.showWarningMessage(vscode.l10n.t('System-wide text selection is unavailable in this build.'));
			}
		} catch {
			// Stock VS Code does not provide the first-party Code-OSS bridge.
		}
	}

	private cancel(): void {
		this.cancellation?.cancel();
	}

	private async addToMemory(): Promise<void> {
		if (this.state.phase !== 'succeeded' || this.state.memory === 'saving' || this.state.memory === 'saved') {
			return;
		}
		const current = this.state;
		const authorization = await this.authorization();
		if (!authorization) {
			this.updateRequest(current.requestId, state => updateMemoryState(state, 'failed', vscode.l10n.t('An access token is required.')));
			return;
		}
		if (!this.isCurrentRequest(current.requestId)) {
			return;
		}
		this.updateRequest(current.requestId, state => updateMemoryState(state, 'saving'));
		try {
			const receipt = await this.client(authorization).saveMemory(
				current.requestId,
				current.snapshot,
				current.text,
				current.traceId,
				current.modelDecisionId,
			);
			this.updateRequest(current.requestId, state => updateMemoryState(state, 'saved', vscode.l10n.t('Added to memory ({0}).', receipt.memoryId)));
		} catch (error) {
			this.updateRequest(current.requestId, state => updateMemoryState(state, 'failed', error instanceof Error ? error.message : String(error)));
		}
	}

	private async authorization(): Promise<string | undefined> {
		const stored = await this.context.secrets.get(accessTokenSecret);
		if (stored) {
			return stored.toLowerCase().startsWith('bearer ') ? stored : `Bearer ${stored}`;
		}
		const development = developmentAuthorization(vscode.workspace.getConfiguration('latentnote.studyBuddy').get<string>('serviceUrl', 'http://127.0.0.1:8787'));
		if (development) {
			return development;
		}
		const token = await this.promptForAccessToken();
		return token ? `Bearer ${token}` : undefined;
	}

	private async setAccessToken(): Promise<void> {
		await this.promptForAccessToken();
	}

	private async promptForAccessToken(): Promise<string | undefined> {
		const token = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Enter the Study Buddy account access token.'),
			password: true,
			ignoreFocusOut: true,
			validateInput: value => value.trim() ? undefined : vscode.l10n.t('Access token cannot be empty.'),
		});
		if (!token?.trim()) {
			return undefined;
		}
		const normalized = token.trim().replace(/^Bearer\s+/i, '');
		await this.context.secrets.store(accessTokenSecret, normalized);
		void vscode.window.showInformationMessage(vscode.l10n.t('Study Buddy access token saved securely.'));
		return normalized;
	}

	private client(authorization: string): StudyBuddyClient {
		const configured = vscode.workspace.getConfiguration('latentnote.studyBuddy').get<string>('serviceUrl', 'http://127.0.0.1:8787');
		let serviceUrl: URL;
		try {
			serviceUrl = new URL(configured);
		} catch {
			throw new StudyBuddyServiceError(vscode.l10n.t('Study Buddy service URL must be a valid HTTP or HTTPS URL.'));
		}
		if (serviceUrl.protocol !== 'http:' && serviceUrl.protocol !== 'https:') {
			throw new StudyBuddyServiceError(vscode.l10n.t('Study Buddy service URL must be a valid HTTP or HTTPS URL.'));
		}
		if (serviceUrl.protocol === 'http:' && !isPrivateNetworkHost(serviceUrl.hostname)) {
			throw new StudyBuddyServiceError(vscode.l10n.t('Study Buddy requires HTTPS for non-private service URLs ({0}).', serviceUrl.hostname));
		}
		return new StudyBuddyClient(serviceUrl.toString(), authorization);
	}

	private setState(state: ExplanationState): void {
		this.state = state;
		this.view.setState(state);
		void this.updateContextKeys();
	}

	private isCurrentRequest(requestId: string): boolean {
		return this.state.phase !== 'idle' && this.state.requestId === requestId;
	}

	private updateRequest(requestId: string, update: (state: ExplanationState) => ExplanationState): void {
		if (this.isCurrentRequest(requestId)) {
			this.setState(update(this.state));
		}
	}

	private async updateContextKeys(): Promise<void> {
		await Promise.all([
			vscode.commands.executeCommand('setContext', 'latentnote.studyBuddy.explanationRunning', this.state.phase === 'running'),
			vscode.commands.executeCommand('setContext', 'latentnote.studyBuddy.explanationCanSave', this.state.phase === 'succeeded' && this.state.memory !== 'saving' && this.state.memory !== 'saved'),
		]);
	}
}

function projectIdFor(resource: vscode.Uri): string {
	const configured = vscode.workspace.getConfiguration('latentnote.studyBuddy').get<string>('projectId')?.trim();
	if (configured) {
		return configured;
	}
	const root = vscode.workspace.getWorkspaceFolder(resource)?.uri.toString(true) ?? resource.toString(true);
	return `code-oss-${createHash('sha256').update(root).digest('hex').slice(0, 32)}`;
}

export function projectIdForSystemSelection(): string {
	const configured = vscode.workspace.getConfiguration('latentnote.studyBuddy').get<string>('projectId')?.trim();
	if (configured) {
		return configured;
	}
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.toString(true) ?? 'empty-window';
	return `code-oss-${createHash('sha256').update(root).digest('hex').slice(0, 32)}`;
}

function isSystemSelectionActionEvent(value: unknown): value is SystemSelectionActionEvent {
	if (!isRecord(value) || !isSelectionAction(value.action) || !isRecord(value.selection)) {
		return false;
	}
	return typeof value.targetWindowId === 'number'
		&& typeof value.actionId === 'string'
		&& typeof value.selection.selectionId === 'string'
		&& typeof value.selection.text === 'string'
		&& value.selection.text.trim().length > 0
		&& typeof value.selection.capturedAt === 'number'
		&& (value.selection.application === undefined || typeof value.selection.application === 'string');
}

function isSystemSelectionSnapshot(value: unknown): value is SystemSelectionSnapshot {
	return isRecord(value)
		&& value.kind === 'system'
		&& typeof value.selectionId === 'string'
		&& typeof value.text === 'string'
		&& typeof value.projectId === 'string'
		&& typeof value.capturedAt === 'number'
		&& (value.application === undefined || typeof value.application === 'string');
}

function isSelectionAction(value: unknown): value is SelectionAction {
	return value === 'explain' || value === 'translate' || value === 'summarize' || value === 'context';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function selectionErrorMessage(error: unknown): string {
	if (error instanceof SelectionSnapshotError) {
		return error.code === 'notMarkdown'
			? vscode.l10n.t('The active editor is not a Markdown text editor.')
			: vscode.l10n.t('Select non-empty Markdown text to explain.');
	}
	return vscode.l10n.t('Unable to capture the editor selection.');
}
