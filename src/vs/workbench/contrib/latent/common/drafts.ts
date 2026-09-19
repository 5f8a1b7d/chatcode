/* eslint-disable header/header */
import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { getChatAttachmentMimeType, IChatRequestVariableEntry } from '../../chat/common/attachments/chatVariableEntries.js';
import { ITabKey } from './tabKey.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IDynamicVariable, toAttachedContextDynamicVariable } from '../../chat/common/attachments/chatVariables.js';

/** One attachment of a Draft. The number is stable for the lifetime of the Draft (P1-FR-050). */
export interface IDraftAttachment {
	readonly number: number;
	readonly entry: IChatRequestVariableEntry;
	readonly addedAt: number;
	/** Set instead of deleting the record so that stale references can be explained (P1-FR-053). */
	readonly removedAt?: number;
}

export interface IDraft {
	readonly tabKey: ITabKey;
	readonly text: string;
	/** All attachments ever added, including removed ones. */
	readonly attachments: readonly IDraftAttachment[];
	readonly nextAttachmentNumber: number;
	readonly updatedAt: number;
}

export type ReferenceDiagnosticKind = 'invalid' | 'stale';

export type ReferenceQuickFix = 'removeReference' | 'reAddAttachment';

/** A `#<number>` reference in the draft text that cannot be sent. */
export interface IReferenceDiagnostic {
	readonly kind: ReferenceDiagnosticKind;
	readonly number: number;
	/** Zero-based character offsets in the draft text. */
	readonly startOffset: number;
	readonly endOffset: number;
	readonly quickFixes: readonly ReferenceQuickFix[];
}

export interface IPreparedDraft {
	/** Text with valid references rewritten for the model (P1-FR-052). */
	readonly text: string;
	/** The original user-visible text. */
	readonly displayText: string;
	/** Live (not removed) attachments in number order. */
	readonly attachments: readonly IDraftAttachment[];
}

export const ITabDraftService = createDecorator<ITabDraftService>('latentTabDraftService');

export interface ITabDraftService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeDraft: Event<ITabKey>;
	getDraft(tabKey: ITabKey): IDraft;
	setText(tabKey: ITabKey, text: string): void;
	/** Adds an attachment and returns its number. */
	addAttachment(tabKey: ITabKey, entry: IChatRequestVariableEntry): number;
	removeAttachment(tabKey: ITabKey, number: number): void;
	/** Restores a removed attachment under a new number and rewrites references to it; returns the new number. */
	reAddAttachment(tabKey: ITabKey, number: number): number | undefined;
	/** Removes every `#<number>` token for the given number from the text. */
	removeReference(tabKey: ITabKey, number: number): void;
	validateReferences(tabKey: ITabKey): readonly IReferenceDiagnostic[];
	/** Throws when validation fails. */
	prepareForSend(tabKey: ITabKey): IPreparedDraft;
	/** Clears text and attachments after a successful send; the counter is kept (P1-FR-051). */
	clearAfterSend(tabKey: ITabKey): void;
	rekey(from: ITabKey, to: ITabKey): void;
}

const referencePattern = /(?<![\w#])#(?<number>\d+)(?::(?<mimeType>[\w.+-]+\/[\w.+-]+))?(?![\w/:.-])/g;

/** Finds `#<number>` tokens in text. */
export function findReferences(text: string): { number: number; mimeType?: string; startOffset: number; endOffset: number }[] {
	const result: { number: number; mimeType?: string; startOffset: number; endOffset: number }[] = [];
	for (const match of text.matchAll(referencePattern)) {
		const number = Number(match.groups?.number);
		if (Number.isFinite(number) && match.index !== undefined) {
			result.push({ number, mimeType: match.groups?.mimeType, startOffset: match.index, endOffset: match.index + match[0].length });
		}
	}
	return result;
}

export function attachmentLabel(entry: IChatRequestVariableEntry): string {
	return entry.name || entry.id;
}

/** MIME used in the visible `#<number>:<MIME>` token for an attachment. */
export function attachmentMimeType(entry: IChatRequestVariableEntry): string {
	return getChatAttachmentMimeType(entry);
}

/** Adds the display metadata consumed by native attachment pills and completions. */
export function toNumberedChatAttachment(attachment: IDraftAttachment): IChatRequestVariableEntry {
	return {
		...attachment.entry,
		attachmentNumber: attachment.number,
		attachmentMimeType: attachmentMimeType(attachment.entry),
	};
}

/** Keep the transcript's #n token while expanding only the model-facing prompt. */
export function createDraftReferences(text: string, attachments: readonly IDraftAttachment[]): IDynamicVariable[] {
	const references: IDynamicVariable[] = [];
	for (const reference of findReferences(text)) {
		const attachment = attachments.find(item => item.number === reference.number && item.removedAt === undefined);
		if (!attachment) { continue; }
		const prefix = text.slice(0, reference.startOffset);
		const line = prefix.split('\n').length;
		const column = reference.startOffset - prefix.lastIndexOf('\n');
		const variable = toAttachedContextDynamicVariable(attachment.entry, new Range(line, column, line, column + reference.endOffset - reference.startOffset));
		references.push({ ...variable, promptText: `[#${reference.number}: ${attachmentLabel(attachment.entry)}]`, _meta: {
			...attachment.entry._meta,
			attachmentPreview: typeof attachment.entry.value === 'string' ? attachment.entry.value : attachmentLabel(attachment.entry),
		} });
	}
	return references;
}

/** Pure validation used by the service and by tests (P1-FR-053). */
export function validateDraftReferences(text: string, attachments: readonly IDraftAttachment[], nextAttachmentNumber: number): IReferenceDiagnostic[] {
	const byNumber = new Map(attachments.map(attachment => [attachment.number, attachment]));
	const diagnostics: IReferenceDiagnostic[] = [];
	for (const reference of findReferences(text)) {
		const attachment = byNumber.get(reference.number);
		if (!attachment || reference.number <= 0 || reference.number >= nextAttachmentNumber && !attachment) {
			diagnostics.push({ kind: 'invalid', number: reference.number, startOffset: reference.startOffset, endOffset: reference.endOffset, quickFixes: ['removeReference'] });
		} else if (attachment.removedAt !== undefined) {
			diagnostics.push({ kind: 'stale', number: reference.number, startOffset: reference.startOffset, endOffset: reference.endOffset, quickFixes: ['reAddAttachment', 'removeReference'] });
		}
	}
	return diagnostics;
}

/** Rewrites valid references as `[#n: <name>]` for the model (P1-FR-052). */
export function rewriteReferencesForModel(text: string, attachments: readonly IDraftAttachment[]): string {
	const byNumber = new Map(attachments.filter(attachment => attachment.removedAt === undefined).map(attachment => [attachment.number, attachment]));
	return text.replace(referencePattern, (token, _number, _mimeType, _offset, _input, groups: { number: string }) => {
		const attachment = byNumber.get(Number(groups.number));
		return attachment ? `[#${attachment.number}: ${attachmentLabel(attachment.entry)}]` : token;
	});
}

/** Removes every `#<number>` token (and one following space) for the given number. */
export function stripReference(text: string, number: number): string {
	return text.replace(referencePattern, (token, _number, _mimeType, _offset, _input, groups: { number: string }) => Number(groups.number) === number ? '' : token).replace(/[ \t]{2,}/g, ' ').trim();
}

/** Renumbers `#<from>` tokens to `#<to>`. */
export function renumberReference(text: string, from: number, to: number): string {
	return text.replace(referencePattern, (token, _number, _mimeType, _offset, _input, groups: { number: string }) => Number(groups.number) === from ? token.replace(`#${from}`, `#${to}`) : token);
}
