/* eslint-disable header/header */
import { IChatRequestVariableEntry } from '../../chat/common/attachments/chatVariableEntries.js';

/** Where a request to open a Side Chat came from. */
export type SideChatOrigin = 'editorArea' | 'secondarySideBar' | 'floatingWindow' | 'systemSelection' | 'commandPalette';

export type SideChatHost = 'editorArea' | 'secondarySideBar';

/** The open-location rule (P1-FR-040..042): side bar origins open in the editor area and vice versa. */
export function resolveSideChatHost(origin: SideChatOrigin): SideChatHost {
	switch (origin) {
		case 'secondarySideBar':
		case 'floatingWindow':
			return 'editorArea';
		default:
			return 'secondarySideBar';
	}
}

export interface ISideChatOpenOptions {
	/** Explicit destination for actions such as the editor title New Thread button. */
	readonly host?: SideChatHost;
	readonly attachments?: readonly IChatRequestVariableEntry[];
	readonly focusInput?: boolean;
	/** Prefill the composer without sending. */
	readonly text?: string;
}
