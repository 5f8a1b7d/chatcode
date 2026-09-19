/* eslint-disable header/header */
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ISharedWebContentExtractorService } from '../../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { ChatAttachmentModel } from '../../../chat/browser/attachments/chatAttachmentModel.js';
import { IChatAttachmentResolveService } from '../../../chat/browser/attachments/chatAttachmentResolveService.js';
import { createPastedTextArtifact } from '../../../chat/browser/widget/input/editor/chatPasteProviders.js';
import { IChatRequestVariableEntry, IGenericChatRequestVariableEntry } from '../../../chat/common/attachments/chatVariableEntries.js';
import { toAttachedContextDynamicVariable } from '../../../chat/common/attachments/chatVariables.js';
import { ChatAttachmentNumbering, getAttachmentNumberCompletion } from '../../browser/attachmentNumbering.js';
import { formatAttachmentNumberName, formatAttachmentNumberReference } from '../../common/attachmentNumbers.js';

suite('Latent attachment numbering', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createModel(numbering: ChatAttachmentNumbering | undefined): ChatAttachmentModel {
		const model = store.add(new ChatAttachmentModel(
			new class extends mock<IFileService>() { },
			new class extends mock<ISharedWebContentExtractorService>() { },
			new class extends mock<IChatAttachmentResolveService>() { },
		));
		model.numbering = numbering;
		return model;
	}

	const generic = (id: string): IGenericChatRequestVariableEntry => ({ kind: 'generic', id, name: 'selection', value: id });

	test('keeps upstream attachments unnumbered when the input does not opt in', () => {
		const model = createModel(undefined);
		model.addContext(generic('first'));
		assert.deepStrictEqual(model.attachments, [generic('first')]);
	});

	test('keeps a referenced implicit file distinct when the active file changes', () => {
		const numbering = new ChatAttachmentNumbering();
		const model = createModel(numbering);
		const entry = (name: string): IChatRequestVariableEntry => ({ kind: 'file', id: 'vscode.implicit.file', name, value: URI.parse(`test:/${name}`) });
		const first = numbering.numberImplicitContext(entry('first.js'), model.attachments);
		model.addContext(first);
		const second = numbering.numberImplicitContext(entry('second.js'), model.attachments);
		assert.deepStrictEqual({
			numbers: [first.attachmentNumber, second.attachmentNumber],
			distinct: first.id !== second.id,
			original: model.attachments[0].name,
		}, { numbers: [1, 2], distinct: true, original: 'first.js' });
	});

	test('shares numbers across implicit context and attachments, preserving updates and deletions', () => {
		const numbering = new ChatAttachmentNumbering();
		const model = createModel(numbering);
		const implicit = numbering.numberImplicitContext(generic('implicit'), model.attachments);
		model.addContext(generic('first'), generic('second'));
		model.updateContext([], [{ ...generic('second'), value: 'updated' }]);
		model.delete('first');
		model.addContext(generic('third'));
		assert.deepStrictEqual({
			implicit: implicit.attachmentNumber,
			implicitAfterUpdate: numbering.numberImplicitContext(generic('implicit'), model.attachments).attachmentNumber,
			attachments: model.attachments.map(item => [item.id, item.attachmentNumber, item.attachmentMimeType, item.value]),
			next: numbering.nextNumber,
		}, {
			implicit: 1,
			implicitAfterUpdate: 1,
			attachments: [['second', 3, 'text/plain', 'updated'], ['third', 4, 'text/plain', 'third']],
			next: 5,
		});
	});

	test('formats names, draft tokens, completions, model-facing references and pasted artifacts', () => {
		const attachment: IChatRequestVariableEntry = { kind: 'generic', id: 'notes', name: 'notes.txt', value: 'preview', attachmentNumber: 4, attachmentMimeType: 'text/plain' };
		const reference = toAttachedContextDynamicVariable(attachment, new Range(1, 1, 1, 14));
		const pasted = createPastedTextArtifact('hello', [], { minLength: 0, attachmentNumber: 3 });
		const pastedMarkdown = createPastedTextArtifact('hello', [], { minLength: 0, attachmentNumber: 4, content: '**hello**' });
		assert.deepStrictEqual({
			name: formatAttachmentNumberName(4, 'notes.txt'),
			token: formatAttachmentNumberReference(4, 'text/plain'),
			completion: getAttachmentNumberCompletion(attachment),
			unnumberedCompletion: getAttachmentNumberCompletion({ ...attachment, attachmentNumber: undefined }),
			promptText: reference.promptText,
			preview: reference._meta?.attachmentPreview,
			pasted: [pasted, pastedMarkdown].map(artifact => [artifact?.referenceText, artifact?.attachment.attachmentNumber, artifact?.attachment.attachmentMimeType]),
		}, {
			name: '4:notes.txt',
			token: '#4:text/plain',
			completion: { label: '4:notes.txt', text: '#4:text/plain' },
			unnumberedCompletion: undefined,
			promptText: '[#4: notes.txt]',
			preview: 'preview',
			pasted: [['#3:text/plain', 3, 'text/plain'], ['#4:text/markdown', 4, 'text/markdown']],
		});
	});
});
