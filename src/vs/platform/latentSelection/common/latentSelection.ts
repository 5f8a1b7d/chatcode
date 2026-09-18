/* eslint-disable header/header */
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/** Channel name kept for one release so older extension builds keep working. */
export const LATENT_SELECTION_CHANNEL = 'studyBuddySelection';

export type SelectionSource = 'editor' | 'thread' | 'system';

/** Immutable snapshot of a selection (P2-FR-010). */
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

/** One action shown in the Selection Bar. `when` has already been evaluated by the workbench. */
export interface ISelectionBarAction {
	readonly id: string;
	readonly label: string;
	readonly icon?: string;
	readonly order: number;
	/** The action streams a result into the bar (Explain, Translate, Summarize). */
	readonly showsResult?: boolean;
}

export interface ISelectionActionEvent {
	readonly targetWindowId: number;
	readonly actionId: string;
	readonly action: string;
	readonly selection: ISelectionSnapshot;
}

export type SelectionOverlayPhase = 'running' | 'succeeded' | 'failed';

export interface ISelectionOverlayUpdate {
	readonly selectionId: string;
	readonly actionId: string;
	readonly action: string;
	readonly phase: SelectionOverlayPhase;
	readonly text?: string;
	/** Shown under "More details" (P2-FR-013). */
	readonly details?: string;
}

export const ILatentSelectionService = createDecorator<ILatentSelectionService>('latentSelectionService');

export interface ILatentSelectionService {
	readonly _serviceBrand: undefined;
	readonly onDidRequestAction: Event<ISelectionActionEvent>;

	setEnabled(windowId: number, enabled: boolean): Promise<boolean>;
	/** Actions offered for system selections, pre-evaluated for `source == system`. */
	setSystemActions(windowId: number, actions: readonly ISelectionBarAction[]): Promise<void>;
	/** Shows the bar for an editor or thread selection captured by the workbench. */
	showSelection(windowId: number, selection: ISelectionSnapshot, actions: readonly ISelectionBarAction[]): Promise<void>;
	updateOverlay(windowId: number, update: ISelectionOverlayUpdate): Promise<void>;
	setPinned(windowId: number, pinned: boolean): Promise<void>;
	hide(windowId: number): Promise<void>;
}

export const MAX_SELECTION_LENGTH = 50_000;

export function isSelectionSnapshot(value: unknown): value is ISelectionSnapshot {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<ISelectionSnapshot>;
	return typeof candidate.selectionId === 'string'
		&& (candidate.source === 'editor' || candidate.source === 'thread' || candidate.source === 'system')
		&& typeof candidate.text === 'string' && candidate.text.length <= MAX_SELECTION_LENGTH
		&& typeof candidate.capturedAt === 'number'
		&& typeof candidate.editable === 'boolean';
}

export function isSelectionBarActions(value: unknown): value is ISelectionBarAction[] {
	return Array.isArray(value) && value.every(action => typeof action === 'object' && action !== null
		&& typeof (action as ISelectionBarAction).id === 'string' && typeof (action as ISelectionBarAction).label === 'string' && typeof (action as ISelectionBarAction).order === 'number');
}

export function isOverlayUpdate(value: unknown): value is ISelectionOverlayUpdate {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<ISelectionOverlayUpdate>;
	return typeof candidate.selectionId === 'string'
		&& typeof candidate.actionId === 'string'
		&& typeof candidate.action === 'string'
		&& (candidate.phase === 'running' || candidate.phase === 'succeeded' || candidate.phase === 'failed')
		&& (candidate.text === undefined || typeof candidate.text === 'string')
		&& (candidate.details === undefined || typeof candidate.details === 'string');
}
