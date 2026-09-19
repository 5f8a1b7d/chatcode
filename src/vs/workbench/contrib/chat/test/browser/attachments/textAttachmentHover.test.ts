/* eslint-disable header/header */
import assert from 'assert';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { getTextAttachmentHoverContent } from '../../../browser/attachments/chatAttachmentWidgets.js';
import { IChatRequestVariableEntry } from '../../../common/attachments/chatVariableEntries.js';

suite('Text attachment hover', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses provider tooltip or a safe, bounded value preview', () => {
		const explicitTooltip = new MarkdownString('Provider preview');
		const entries: IChatRequestVariableEntry[] = [{
			kind: 'generic',
			id: 'explicit',
			name: 'Explicit',
			value: 'fallback',
			tooltip: explicitTooltip,
		}, {
			kind: 'generic',
			id: 'selection',
			name: 'Selection (thread)',
			value: Array.from({ length: 13 }, (_, index) => index === 0 ? '*selected*' : `line ${index + 1}`).join('\n'),
		}, {
			kind: 'generic',
			id: 'empty',
			name: 'Empty',
			value: '   ',
		}];

		assert.deepStrictEqual(entries.map(entry => {
			const hover = getTextAttachmentHoverContent(entry);
			return {
				isExplicitTooltip: hover === explicitTooltip,
				value: hover?.value,
			};
		}), [{
			isExplicitTooltip: true,
			value: 'Provider preview',
		}, {
			isExplicitTooltip: false,
			value: '\\*selected\\*\n\nline&nbsp;2\n\nline&nbsp;3\n\nline&nbsp;4\n\nline&nbsp;5\n\nline&nbsp;6\n\nline&nbsp;7\n\nline&nbsp;8\n\nline&nbsp;9\n\nline&nbsp;10\n\nline&nbsp;11\n\nline&nbsp;12\n\n…',
		}, {
			isExplicitTooltip: false,
			value: undefined,
		}]);
	});
});
