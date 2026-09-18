/* eslint-disable header/header */
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const STUDY_BUDDY_SELECTION_CHANNEL = 'studyBuddySelection';

export type StudyBuddySelectionAction = 'explain' | 'translate' | 'summarize' | 'context';

export interface IStudyBuddySystemSelection {
	readonly selectionId: string;
	readonly text: string;
	readonly capturedAt: number;
	readonly application?: string;
}

export interface IStudyBuddySelectionActionEvent {
	readonly targetWindowId: number;
	readonly actionId: string;
	readonly action: StudyBuddySelectionAction;
	readonly selection: IStudyBuddySystemSelection;
}

export type StudyBuddySelectionOverlayUpdate =
	| { readonly selectionId: string; readonly actionId: string; readonly phase: 'running'; readonly action: StudyBuddySelectionAction; readonly text?: string }
	| { readonly selectionId: string; readonly actionId: string; readonly phase: 'succeeded'; readonly action: StudyBuddySelectionAction; readonly text: string }
	| { readonly selectionId: string; readonly actionId: string; readonly phase: 'failed'; readonly action: StudyBuddySelectionAction; readonly text: string };

export const IStudyBuddySelectionService = createDecorator<IStudyBuddySelectionService>('studyBuddySelectionService');

export interface IStudyBuddySelectionService {
	readonly _serviceBrand: undefined;
	readonly onDidRequestAction: Event<IStudyBuddySelectionActionEvent>;

	setEnabled(windowId: number, enabled: boolean): Promise<boolean>;
	showEditorSelection(windowId: number, text: string): Promise<void>;
	updateOverlay(windowId: number, update: StudyBuddySelectionOverlayUpdate): Promise<void>;
}
