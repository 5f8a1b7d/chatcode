export interface SelectionPosition {
	readonly line: number;
	readonly character: number;
}

interface SelectionSnapshotBase {
	readonly text: string;
	readonly projectId: string;
	readonly capturedAt: number;
}

export interface EditorSelectionSnapshot extends SelectionSnapshotBase {
	readonly kind: 'editor';
	readonly uri: string;
	readonly documentVersion: number;
	readonly range: {
		readonly start: SelectionPosition;
		readonly end: SelectionPosition;
	};
}

export interface SystemSelectionSnapshot extends SelectionSnapshotBase {
	readonly kind: 'system';
	readonly selectionId: string;
	readonly application?: string;
}

export type SelectionSnapshot = EditorSelectionSnapshot | SystemSelectionSnapshot;

export interface SelectionSnapshotInput extends Omit<EditorSelectionSnapshot, 'kind' | 'capturedAt'> {
	readonly languageId: string;
}

export class SelectionSnapshotError extends Error {
	constructor(readonly code: 'notMarkdown' | 'emptySelection') {
		super(code);
	}
}

export function createSelectionSnapshot(input: SelectionSnapshotInput): EditorSelectionSnapshot {
	if (input.languageId !== 'markdown') {
		throw new SelectionSnapshotError('notMarkdown');
	}
	if (!input.text.trim()) {
		throw new SelectionSnapshotError('emptySelection');
	}
	return Object.freeze({
		kind: 'editor' as const,
		text: input.text,
		uri: input.uri,
		projectId: input.projectId,
		capturedAt: Date.now(),
		documentVersion: input.documentVersion,
		range: Object.freeze({
			start: Object.freeze({ ...input.range.start }),
			end: Object.freeze({ ...input.range.end }),
		}),
	});
}
