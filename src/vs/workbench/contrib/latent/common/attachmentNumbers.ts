/* eslint-disable header/header */
import { getMediaOrTextMime, Mimes } from '../../../../base/common/mime.js';
import { IChatRequestVariableEntry } from '../../chat/common/attachments/chatVariableEntries.js';

/** Label shown for a numbered attachment, `<number>:<name>` (P1-FR-050). */
export function formatAttachmentNumberName(number: number, name: string): string {
	return `${number}:${name}`;
}

/** Draft token referencing a numbered attachment, `#<number>:<MIME>` (P1-FR-052). */
export function formatAttachmentNumberReference(number: number, mimeType: string): string {
	return `#${number}:${mimeType}`;
}

/** Model-facing expansion of a numbered reference, `[#<number>: <name>]` (P1-FR-052). */
export function formatAttachmentNumberPrompt(number: number, name: string): string {
	return `[#${number}: ${name}]`;
}

/** MIME displayed in a numbered reference. */
export function getAttachmentNumberMimeType(entry: IChatRequestVariableEntry): string {
	if (entry.attachmentMimeType) {
		return entry.attachmentMimeType;
	}
	if ((entry.kind === 'image' || entry.kind === 'notebookOutput') && entry.mimeType) {
		return entry.mimeType;
	}
	const resource = IChatRequestVariableEntry.toUri(entry);
	if (resource) {
		return getMediaOrTextMime(resource.path) ?? (entry.kind === 'file' ? Mimes.text : Mimes.binary);
	}
	return typeof entry.value === 'string' ? Mimes.text : Mimes.unknown;
}
