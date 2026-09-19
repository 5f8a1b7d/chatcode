import type * as vscode from 'vscode';

export type SelectionSource = 'editor' | 'thread' | 'system';

/** Immutable snapshot of a selection, mirrored from the workbench (spec 02 §4). */
export interface ISelectionSnapshot {
	readonly selectionId: string;
	readonly source: SelectionSource;
	readonly text: string;
	readonly capturedAt: number;
	readonly editable: boolean;
	readonly application?: string;
	readonly uri?: string;
	readonly range?: { readonly start: { readonly line: number; readonly character: number }; readonly end: { readonly line: number; readonly character: number } };
	readonly languageId?: string;
	readonly threadId?: string;
	readonly turnId?: string;
	readonly truncated?: boolean;
}

export type ProviderCapability = 'text' | 'imageUnderstanding' | 'asr' | 'tts' | 'realtimeVoice';

export interface ISelectionActionContext {
	readonly selection: ISelectionSnapshot;
	readonly bar: { report(update: { phase: 'running' | 'succeeded' | 'failed'; text?: string; details?: string }): void };
	readonly token: vscode.CancellationToken;
}

export interface ISelectionActionDescriptor {
	readonly id: string;
	readonly title: string;
	readonly icon?: string;
	readonly order: number;
	/** Context-key expression over `latent.selection.source`, `latent.selection.editable`, `latent.selection.languageId`, `latent.selection.hasThread`. */
	readonly when?: string;
	readonly requires?: readonly ProviderCapability[];
	/** The action streams a result into the bar. */
	readonly showsResult?: boolean;
	run(context: ISelectionActionContext): Promise<void>;
}

export interface IAddToNoteHandler {
	readonly id: string;
	handle(selection: ISelectionSnapshot): Promise<void>;
}

export interface ILatentSelectionApi {
	readonly version: 1;
	registerSelectionAction(descriptor: ISelectionActionDescriptor): vscode.Disposable;
	/** Registration only in this phase; nothing is persisted by the Selection extension (P2-FR-002). */
	registerAddToNoteHandler(handler: IAddToNoteHandler): vscode.Disposable;
	readonly onDidRunAction: vscode.Event<{ readonly actionId: string; readonly selection: ISelectionSnapshot }>;
	pin(pinned: boolean): Promise<void>;
}
