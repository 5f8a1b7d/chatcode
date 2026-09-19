/* eslint-disable header/header */
import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ISharedWebContentExtractorService } from '../../../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { ChatAttachmentModel } from '../../../browser/attachments/chatAttachmentModel.js';
import { IChatAttachmentResolveService } from '../../../browser/attachments/chatAttachmentResolveService.js';
import { IChatRequestVariableEntry, IGenericChatRequestVariableEntry } from '../../../common/attachments/chatVariableEntries.js';

suite('Chat attachment numbering', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps a referenced implicit file distinct when the active file changes', () => {
		const model = store.add(new ChatAttachmentModel(
			new class extends mock<IFileService>() { },
			new class extends mock<ISharedWebContentExtractorService>() { },
			new class extends mock<IChatAttachmentResolveService>() { },
		));
		const entry = (name: string): IChatRequestVariableEntry => ({ kind: 'file', id: 'vscode.implicit.file', name, value: URI.parse(`test:/${name}`) });
		const first = model.getNumberedImplicitContext(entry('first.js'));
		model.addContext(first);
		const second = model.getNumberedImplicitContext(entry('second.js'));
		assert.deepStrictEqual({
			numbers: [first.attachmentNumber, second.attachmentNumber],
			distinct: first.id !== second.id,
			original: model.attachments[0].name,
		}, { numbers: [1, 2], distinct: true, original: 'first.js' });
	});

	test('shares numbers across implicit context and same-name attachments, preserving updates and deletions', () => {
		const model = store.add(new ChatAttachmentModel(
			new class extends mock<IFileService>() { },
			new class extends mock<ISharedWebContentExtractorService>() { },
			new class extends mock<IChatAttachmentResolveService>() { },
		));
		const entry = (id: string): IGenericChatRequestVariableEntry => ({ kind: 'generic', id, name: 'selection', value: id });
		const implicit = model.getNumberedImplicitContext(entry('implicit'));
		model.addContext(entry('first'), entry('second'));
		model.updateContext([], [{ ...entry('second'), value: 'updated' }]);
		model.delete('first');
		model.addContext(entry('third'));
		assert.deepStrictEqual({
			implicit: implicit.attachmentNumber,
			implicitAfterUpdate: model.getNumberedImplicitContext(entry('implicit')).attachmentNumber,
			attachments: model.attachments.map(item => [item.id, item.attachmentNumber, item.attachmentMimeType, item.value]),
			next: model.nextAttachmentNumber,
		}, {
			implicit: 1,
			implicitAfterUpdate: 1,
			attachments: [['second', 3, 'text/plain', 'updated'], ['third', 4, 'text/plain', 'third']],
			next: 5,
		});
	});
});
