import type { SelectionSnapshot } from '../editor/selection';

export type ExplanationState =
	| { readonly phase: 'idle' }
	| {
		readonly phase: 'running';
		readonly requestId: string;
		readonly snapshot: SelectionSnapshot;
		readonly text: string;
	}
	| {
		readonly phase: 'succeeded';
		readonly requestId: string;
		readonly snapshot: SelectionSnapshot;
		readonly text: string;
		readonly memory: 'available' | 'saving' | 'saved' | 'failed';
		readonly memoryMessage?: string;
		readonly traceId?: string;
		readonly modelDecisionId?: string;
	}
	| {
		readonly phase: 'failed' | 'cancelled';
		readonly requestId: string;
		readonly snapshot: SelectionSnapshot;
		readonly text: string;
		readonly message: string;
	};

export function beginExplanation(
	requestId: string,
	snapshot: SelectionSnapshot,
): ExplanationState {
	return { phase: 'running', requestId, snapshot, text: '' };
}

export function appendExplanationDelta(state: ExplanationState, delta: string): ExplanationState {
	if (state.phase !== 'running' || !delta) {
		return state;
	}
	return { ...state, text: state.text + delta };
}

export function completeExplanation(
	state: ExplanationState,
	finalText: string,
	traceId?: string,
	modelDecisionId?: string,
): ExplanationState {
	if (state.phase !== 'running') {
		return state;
	}
	const text = finalText || state.text;
	if (!text.trim()) {
		return failExplanation(state, 'Study Buddy returned an empty explanation.');
	}
	return { ...state, phase: 'succeeded', text, memory: 'available', traceId, modelDecisionId };
}

export function failExplanation(
	state: ExplanationState,
	message: string,
	phase: 'failed' | 'cancelled' = 'failed',
): ExplanationState {
	if (state.phase !== 'running') {
		return state;
	}
	return { ...state, phase, message };
}

export function updateMemoryState(
	state: ExplanationState,
	memory: 'saving' | 'saved' | 'failed',
	memoryMessage?: string,
): ExplanationState {
	if (state.phase !== 'succeeded') {
		return state;
	}
	return { ...state, memory, memoryMessage };
}
