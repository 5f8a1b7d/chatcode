import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseCanonicalEvent, parseMemoryReceipt, SseDecoder } from '../backend/protocol';
import { createSelectionSnapshot } from '../editor/selection';
import { appendExplanationDelta, beginExplanation, completeExplanation, updateMemoryState } from '../learning/explanationState';

describe('Study Buddy Markdown workflow', () => {
	test('freezes the selected text and source range', () => {
		const snapshot = createSelectionSnapshot({
			languageId: 'markdown', text: 'immutable selection', uri: 'file:///notes/example.md', projectId: 'project-1', documentVersion: 7,
			range: { start: { line: 2, character: 1 }, end: { line: 2, character: 20 } },
		});
		assert.deepStrictEqual(snapshot, {
			kind: 'editor', capturedAt: snapshot.capturedAt,
			text: 'immutable selection', uri: 'file:///notes/example.md', projectId: 'project-1', documentVersion: 7,
			range: { start: { line: 2, character: 1 }, end: { line: 2, character: 20 } },
		});
		assert.equal(Object.isFrozen(snapshot), true);
		assert.equal(Object.isFrozen(snapshot.range.start), true);
	});

	test('decodes fragmented canonical SSE and preserves incremental state', () => {
		const decoder = new SseDecoder();
		const first = decoder.accept('id: 0\ndata: {"type":"text_delta","te');
		const second = decoder.accept('xt":"hello "}\r');
		const third = decoder.accept('\n\r\nid: 1\r\ndata: {"type":"text_delta","text":"world"}\r\n\r\n');
		decoder.finish();
		const events = [...first, ...second, ...third].map(parseCanonicalEvent);
		const snapshot = createSelectionSnapshot({
			languageId: 'markdown', text: 'selection', uri: 'file:///note.md', projectId: 'project-1', documentVersion: 1,
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
		});
		let state = beginExplanation('request-1', snapshot);
		for (const event of events) {
			if (event?.type === 'text_delta') {
				state = appendExplanationDelta(state, event.text);
			}
		}
		state = completeExplanation(state, 'hello world');
		state = updateMemoryState(state, 'saved', 'memory-1');
		if (state.phase !== 'succeeded') {
			throw new Error(`Expected succeeded state, got ${state.phase}`);
		}
		assert.deepStrictEqual(
			{ phase: state.phase, text: state.text, memory: state.memory },
			{ phase: 'succeeded', text: 'hello world', memory: 'saved' },
		);
	});

	test('uses the canonical finished message when deltas are incomplete', () => {
		const snapshot = createSelectionSnapshot({
			languageId: 'markdown', text: 'selection', uri: 'file:///note.md', projectId: 'project-1', documentVersion: 1,
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
		});
		let state = appendExplanationDelta(beginExplanation('request-1', snapshot), 'partial');
		state = completeExplanation(state, 'authoritative final text');
		assert.deepStrictEqual(
			state.phase === 'succeeded' ? { phase: state.phase, text: state.text } : state,
			{ phase: 'succeeded', text: 'authoritative final text' },
		);
		const incomplete = new SseDecoder();
		incomplete.accept('data: {"type":"text_delta"}');
		assert.throws(() => incomplete.finish());
	});

	test('parses terminal failures and durable memory receipts', () => {
		assert.deepStrictEqual(parseCanonicalEvent('{"type":"failed","failure":{"code":"binding_unavailable"}}'), { type: 'failed', code: 'binding_unavailable' });
		assert.deepStrictEqual(
			parseMemoryReceipt({ schemaVersion: 1, memoryId: 'memory-1', persistedAt: '2026-09-13T00:00:00.000Z' }),
			{ schemaVersion: 1, memoryId: 'memory-1', persistedAt: '2026-09-13T00:00:00.000Z' },
		);
	});
});
