import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isSelectionActionEvent, languageDisplayName, resolveTargetLanguage, translationPrompt } from '../selection/snapshot';

describe('Latent selection (P2-AS-005)', () => {
	test('translate target defaults to the OS locale, not the UI language', () => {
		assert.deepStrictEqual([
			resolveTargetLanguage('os', 'zh-CN', 'en-US'),
			resolveTargetLanguage(undefined, 'zh-CN', 'en-US'),
			resolveTargetLanguage('ja', 'zh-CN', 'en-US'),
			resolveTargetLanguage('os', undefined, 'de-DE'),
			resolveTargetLanguage('os', '', ''),
		], ['zh-CN', 'zh-CN', 'ja', 'de-DE', 'en']);
	});

	test('translation prompt names the target and the label is human readable', () => {
		assert.ok(translationPrompt('zh-CN').includes('中文（简体） (zh-CN)'));
		assert.strictEqual(languageDisplayName('pt-BR'), 'Português (Brasil)');
		assert.strictEqual(languageDisplayName('xx-YY'), 'xx-YY');
	});

	test('validates action events from the workbench', () => {
		const selection = { selectionId: '1', source: 'thread', text: 'hello', capturedAt: 1, editable: false, threadId: 't' };
		assert.deepStrictEqual([
			isSelectionActionEvent({ targetWindowId: 1, actionId: 'a', action: 'latent.selection.explain', selection }),
			isSelectionActionEvent({ targetWindowId: 1, actionId: 'a', action: 'x', selection: { ...selection, source: 'nope' } }),
			isSelectionActionEvent(undefined),
		], [true, false, false]);
	});
});
