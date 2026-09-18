import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSelectionSnapshot } from '../editor/selection';
import { parseCanonicalEvent, SseDecoder } from '../backend/protocol';
import { appendExplanationDelta, beginExplanation, completeExplanation } from '../learning/explanationState';

test('selection snapshot freezes exact source text and coordinates', () => {
	const snapshot = createSelectionSnapshot({
		languageId: 'markdown',
		uri: 'file:///notes/topic.md',
		projectId: 'project-a',
		documentVersion: 7,
		text: 'immutable text',
		range: {
			start: { line: 2, character: 3 },
			end: { line: 4, character: 8 },
		},
	});

	assert.equal(Object.isFrozen(snapshot), true);
	assert.equal(Object.isFrozen(snapshot.range.start), true);
	assert.deepStrictEqual(snapshot.range.start, { line: 2, character: 3 });
});

test('canonical SSE decoder preserves fragmented text deltas and terminal output', () => {
	const decoder = new SseDecoder();
	const chunks = [
		'id: 0\r\ndata: {"type":"text_delta","text":"第一',
		'段"}\r\n\r\nid: 1\ndata: {"type":"text_delta","text":"解释"}\n\n',
		'id: 2\ndata: {"type":"finished","message":[{"type":"text","text":"第一段解释"}]}\n\n',
	];
	const snapshot = createSelectionSnapshot({
		languageId: 'markdown',
		uri: 'file:///notes/topic.md',
		projectId: 'project-a',
		documentVersion: 7,
		text: 'immutable text',
		range: {
			start: { line: 2, character: 3 },
			end: { line: 4, character: 8 },
		},
	});
	let state = beginExplanation('task-1', snapshot);
	let finalText = '';
	for (const chunk of chunks) {
		for (const data of decoder.accept(chunk)) {
			const event = parseCanonicalEvent(data);
			if (event?.type === 'text_delta') {
				state = appendExplanationDelta(state, event.text);
			} else if (event?.type === 'finished') {
				finalText = event.text;
			}
		}
	}
	decoder.finish();
	state = completeExplanation(state, finalText);

	assert.deepStrictEqual(
		state.phase === 'succeeded' ? { phase: state.phase, text: state.text } : state,
		{ phase: 'succeeded', text: '第一段解释' },
	);
});
