/* eslint-disable header/header */
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { IRuntimeSessionTurn } from '../../../../../platform/latentRuntime/common/runtimeProtocol.js';
import { IChatSessionHistoryItem } from '../../../chat/common/chatSessionsService.js';

/** Read-only projection: opening a Bot transcript never submits another Bot input. */
export function runtimeSessionHistory(turns: readonly IRuntimeSessionTurn[]): IChatSessionHistoryItem[] {
	const history: IChatSessionHistoryItem[] = [];
	for (const turn of [...turns].sort((a, b) => a.seq - b.seq)) {
		if (turn.role === 'user') {
			history.push({ type: 'request', id: String(turn.seq), prompt: turn.text, participant: '', timestamp: turn.timestamp });
		} else {
			const previous = history[history.length - 1];
			const content = new MarkdownString(turn.text);
			if (previous?.type === 'response') {
				previous.parts.push({ kind: 'markdownContent', content });
			} else {
				history.push({ type: 'response', parts: [{ kind: 'markdownContent', content }], participant: '', completedAt: turn.timestamp });
			}
		}
	}
	return history;
}
