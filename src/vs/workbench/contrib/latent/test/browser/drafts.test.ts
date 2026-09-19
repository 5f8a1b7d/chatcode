/* eslint-disable header/header */
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IChatRequestVariableEntry } from '../../../chat/common/attachments/chatVariableEntries.js';
import { DraftReferenceError, TabDraftService } from '../../browser/drafts/tabDraftService.js';
import { attachmentMimeType, findReferences, renumberReference, rewriteReferencesForModel, stripReference, toNumberedChatAttachment, validateDraftReferences } from '../../common/drafts.js';
import { ITabKey } from '../../common/tabKey.js';

function entry(name: string): IChatRequestVariableEntry {
	return { kind: 'file', id: `file:${name}`, name, value: URI.file(`/w/${name}`) } as IChatRequestVariableEntry;
}

const tabA: ITabKey = { groupId: 1, typeId: 'text', resource: URI.file('/w/a.md') };
const tabB: ITabKey = { groupId: 1, typeId: 'text', resource: URI.file('/w/b.md') };
const tabA2: ITabKey = { groupId: 2, typeId: 'text', resource: URI.file('/w/a.md') };

suite('Latent drafts', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(): TabDraftService {
		const storage = disposables.add(new InMemoryStorageService());
		return disposables.add(new TabDraftService(storage, new TestConfigurationService()));
	}

	test('finds #n references but not words or hashes', () => {
		assert.deepStrictEqual(findReferences('see #1:text/plain and #12, not a#3 or ##4 or #x').map(r => ({ number: r.number, mimeType: r.mimeType })), [
			{ number: 1, mimeType: 'text/plain' },
			{ number: 12, mimeType: undefined },
		]);
	});

	test('numbers attachment labels and keeps MIME tokens intact while editing references', () => {
		const attachment = { number: 2, entry: entry('script.js'), addedAt: 1 };
		assert.deepStrictEqual(toNumberedChatAttachment(attachment), {
			...attachment.entry,
			attachmentNumber: 2,
			attachmentMimeType: 'text/javascript',
		});
		assert.strictEqual(attachmentMimeType(entry('script.js')), 'text/javascript');
		assert.strictEqual(renumberReference('compare #2:text/javascript', 2, 5), 'compare #5:text/javascript');
		assert.strictEqual(stripReference('compare #2:text/javascript next', 2), 'compare next');
	});

	test('numbers are stable and never reused (P1-AS-010)', () => {
		const service = createService();
		assert.strictEqual(service.addAttachment(tabA, entry('one')), 1);
		assert.strictEqual(service.addAttachment(tabA, entry('two')), 2);
		assert.strictEqual(service.addAttachment(tabA, entry('three')), 3);
		service.removeAttachment(tabA, 2);
		assert.strictEqual(service.addAttachment(tabA, entry('four')), 4);
		const live = service.getDraft(tabA).attachments.filter(a => a.removedAt === undefined).map(a => a.number);
		assert.deepStrictEqual(live, [1, 3, 4]);
	});

	test('preserves widget-assigned numbers when synchronizing a draft', () => {
		const service = createService();
		service.addAttachment(tabA, entry('automatic'));
		const number = service.addAttachment(tabA, { ...entry('paste'), attachmentNumber: 3 });
		service.setText(tabA, 'read #3:text/plain');
		assert.deepStrictEqual({
			number,
			next: service.addAttachment(tabA, entry('next')),
			prompt: service.prepareForSend(tabA).text,
		}, { number: 3, next: 4, prompt: 'read [#3: paste]' });
	});

	test('restores the same numbered reference when a paste is undone and redone', () => {
		const service = createService();
		const pasted = { ...entry('paste'), attachmentNumber: 3 };
		service.addAttachment(tabA, pasted);
		service.setText(tabA, '#3:text/plain');
		service.removeAttachment(tabA, 3);
		service.addAttachment(tabA, pasted);
		assert.deepStrictEqual({
			numbers: service.getDraft(tabA).attachments.map(attachment => attachment.number),
			prompt: service.prepareForSend(tabA).text,
		}, { numbers: [3], prompt: '[#3: paste]' });
	});

	test('drafts are isolated per tab and per group (P1-AS-001, P1-AS-002)', () => {
		const service = createService();
		service.setText(tabA, 'hello #1');
		service.addAttachment(tabA, entry('a'));
		assert.deepStrictEqual({ text: service.getDraft(tabB).text, next: service.getDraft(tabB).nextAttachmentNumber }, { text: '', next: 1 });
		assert.deepStrictEqual({ text: service.getDraft(tabA2).text, next: service.getDraft(tabA2).nextAttachmentNumber }, { text: '', next: 1 });
		service.rekey(tabA, tabA2);
		assert.deepStrictEqual({ text: service.getDraft(tabA2).text, next: service.getDraft(tabA2).nextAttachmentNumber, old: service.getDraft(tabA).text }, { text: 'hello #1', next: 2, old: '' });
	});

	test('invalid references block send with a remove quick fix (P1-AS-011)', () => {
		const service = createService();
		service.addAttachment(tabA, entry('a'));
		service.setText(tabA, 'see #7');
		assert.deepStrictEqual(service.validateReferences(tabA).map(d => [d.kind, d.number, d.quickFixes]), [['invalid', 7, ['removeReference']]]);
		assert.throws(() => service.prepareForSend(tabA), DraftReferenceError);
		service.removeReference(tabA, 7);
		assert.deepStrictEqual({ text: service.getDraft(tabA).text, diagnostics: service.validateReferences(tabA) }, { text: 'see', diagnostics: [] });
	});

	test('stale references can be re-added and are renumbered (P1-AS-012)', () => {
		const service = createService();
		service.addAttachment(tabA, entry('a'));
		service.addAttachment(tabA, entry('b'));
		service.setText(tabA, 'see #2');
		service.removeAttachment(tabA, 2);
		assert.deepStrictEqual(service.validateReferences(tabA).map(d => [d.kind, d.number, d.quickFixes]), [['stale', 2, ['reAddAttachment', 'removeReference']]]);
		assert.strictEqual(service.reAddAttachment(tabA, 2), 3);
		const prepared = service.prepareForSend(tabA);
		assert.deepStrictEqual({ text: prepared.text, display: prepared.displayText, numbers: prepared.attachments.map(a => a.number) }, { text: 'see [#3: b]', display: 'see #3', numbers: [1, 3] });
	});

	test('valid references are rewritten for the model only (P1-AS-013)', () => {
		const attachments = [
			{ number: 1, entry: entry('a.md'), addedAt: 1 },
			{ number: 3, entry: entry('selection'), addedAt: 2 },
		];
		assert.strictEqual(rewriteReferencesForModel('compare #1:text/plain and #3:text/plain', attachments), 'compare [#1: a.md] and [#3: selection]');
		assert.deepStrictEqual(validateDraftReferences('compare #1:text/plain and #3:text/plain', attachments, 4), []);
	});

	test('clearAfterSend keeps the counter (P1-FR-051)', () => {
		const service = createService();
		service.addAttachment(tabA, entry('a'));
		service.setText(tabA, 'x');
		service.clearAfterSend(tabA);
		assert.deepStrictEqual({ text: service.getDraft(tabA).text, count: service.getDraft(tabA).attachments.length, next: service.getDraft(tabA).nextAttachmentNumber }, { text: '', count: 0, next: 2 });
	});
});
