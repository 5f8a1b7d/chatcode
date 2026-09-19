/* eslint-disable header/header */
import { basename } from '../../../../base/common/resources.js';
import { isLocation } from '../../../../editor/common/languages.js';
import { IChatRequestVariableEntry, isAgentHostCompletionVariableEntry } from '../../chat/common/attachments/chatVariableEntries.js';
import { isImplicitContextAlreadyAttached } from '../../chat/browser/attachments/implicitContextAttachment.js';
import { formatAttachmentNumberName, formatAttachmentNumberReference, getAttachmentNumberMimeType } from '../common/attachmentNumbers.js';

/**
 * Attachment Numbers for one chat input (P1-FR-050/051).
 *
 * Upstream chat code only consults this strategy when the hosting widget opts in through
 * `IChatWidgetViewOptions.attachmentNumbering`; without it every call site keeps the upstream
 * behaviour. Explicit attachments and implicit context share one counter, and numbers are
 * never reused.
 */
export class ChatAttachmentNumbering {

	private next = 1;
	private readonly implicitContextNumbers = new Map<string, number>();

	/** Number the next attachment of this input receives. */
	get nextNumber(): number {
		return this.next;
	}

	/** Keeps the number of an attachment across updates, or assigns the next one. */
	numberAttachment(entry: IChatRequestVariableEntry, previous: IChatRequestVariableEntry | undefined): IChatRequestVariableEntry {
		if (isAgentHostCompletionVariableEntry(entry)) {
			return entry;
		}
		const attachmentNumber = entry.attachmentNumber ?? previous?.attachmentNumber ?? this.next;
		this.next = Math.max(this.next, attachmentNumber + 1);
		return { ...entry, attachmentNumber, attachmentMimeType: getAttachmentNumberMimeType(entry) };
	}

	/**
	 * Numbers one implicit context suggestion. Its id includes the resource and range so a
	 * referenced suggestion stays distinct after the active editor changes.
	 */
	numberImplicitContext(entry: IChatRequestVariableEntry, attachments: readonly IChatRequestVariableEntry[]): IChatRequestVariableEntry {
		const resource = IChatRequestVariableEntry.toUri(entry);
		const range = isLocation(entry.value) ? entry.value.range : undefined;
		const id = resource ? `${entry.id}:${resource.toString()}:${range ? `${range.startLineNumber},${range.startColumn}-${range.endLineNumber},${range.endColumn}` : ''}` : entry.id;
		let number = this.implicitContextNumbers.get(entry.id);
		if (number === undefined || attachments.some(attachment => attachment.attachmentNumber === number && attachment.id !== id)) {
			number = this.next++;
			this.implicitContextNumbers.set(entry.id, number);
		}
		return { ...entry, id, name: resource && entry.kind === 'file' ? basename(resource) : entry.name, attachmentNumber: number, attachmentMimeType: getAttachmentNumberMimeType(entry) };
	}

	/** Numbers the implicit context sent with a request, skipping suggestions already attached. */
	numberImplicitContexts(entries: readonly IChatRequestVariableEntry[], attachments: readonly IChatRequestVariableEntry[]): IChatRequestVariableEntry[] {
		return entries
			.filter(entry => !isImplicitContextAlreadyAttached(attachments, IChatRequestVariableEntry.toUri(entry), isLocation(entry.value) ? entry.value.range : undefined, entry.kind === 'string' ? entry.handle : undefined))
			.map(entry => this.numberImplicitContext(entry, attachments));
	}
}

/** Completion label and inserted `#<number>:<MIME>` token of a numbered attachment. */
export function getAttachmentNumberCompletion(entry: IChatRequestVariableEntry): { readonly label: string; readonly text: string } | undefined {
	if (entry.attachmentNumber === undefined || !entry.attachmentMimeType) {
		return undefined;
	}
	return {
		label: formatAttachmentNumberName(entry.attachmentNumber, entry.name),
		text: formatAttachmentNumberReference(entry.attachmentNumber, entry.attachmentMimeType),
	};
}
