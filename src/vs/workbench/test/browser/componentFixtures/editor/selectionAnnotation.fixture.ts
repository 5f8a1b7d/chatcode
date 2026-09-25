/* eslint-disable header/header */
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { CodeEditorWidget, ICodeEditorWidgetOptions } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from '../../../../contrib/chat/browser/speechToText/chatSpeechToTextService.js';
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import { SelectionAttachmentCommentWidget } from '../../../../contrib/latentSelection/electron-browser/latentSelection.contribution.js';
import { ComponentFixtureContext, createEditorServices, createTextModel, defineComponentFixture, defineThemedFixtureGroup } from '../fixtureUtils.js';

const SAMPLE_CODE = [
	'function normalizeSelection(value: string) {',
	'\tconst trimmed = value.trim();',
	'\tif (!trimmed) {',
	'\t\treturn undefined;',
	'\t}',
	'\treturn trimmed.toLocaleLowerCase();',
	'}',
	'',
	'normalizeSelection(" Example ");',
].join('\n');

const speechToTextService = new class extends mock<IChatSpeechToTextService>() {
	override readonly state = ChatSpeechToTextState.Idle;
	override readonly isBusy = false;
	override readonly isConfigured = true;
	override readonly isPreparingModel = false;
	override readonly showTranscriptWhileDictating = true;
	override readonly onDidUpdateTranscript = Event.None;
	override readonly onDidChangeState = Event.None;
	override readonly onDidChangePreparingModel = Event.None;
}();

function renderSelectionAnnotation(context: ComponentFixtureContext, editing: boolean): void {
	const { container, disposableStore, theme } = context;
	container.style.width = '720px';
	container.style.height = '320px';
	container.style.border = '1px solid var(--vscode-editorWidget-border)';

	const instantiationService = createEditorServices(disposableStore, { colorTheme: theme });
	const model = disposableStore.add(createTextModel(
		instantiationService,
		SAMPLE_CODE,
		URI.parse('inmemory://selection-annotation.ts'),
		'typescript',
	));
	const editor = disposableStore.add(instantiationService.createInstance(
		CodeEditorWidget,
		container,
		{
			automaticLayout: true,
			fontSize: 14,
			lineNumbers: 'on',
			minimap: { enabled: false },
			renderLineHighlight: 'none',
			scrollBeyondLastLine: false,
		},
		{ contributions: [] } satisfies ICodeEditorWidgetOptions,
	));
	editor.setModel(model);
	editor.setPosition({ lineNumber: 9, column: 1 });

	const widget = disposableStore.add(new SelectionAttachmentCommentWidget(
		editor,
		new Range(2, 2, 6, 18),
		7,
		'Add an optional comment…',
		'Edit optional comment for attachment #7',
		speechToTextService,
		new NullLogService(),
		() => undefined,
	));

	if (editing) {
		widget.showEditor();
		const textarea = container.querySelector<HTMLTextAreaElement>('.latent-selection-comment-input textarea');
		if (textarea) {
			textarea.value = [
				'Keep the empty-value branch unchanged.',
				'Explain why locale-aware casing is required.',
				'Check callers before renaming this helper.',
				'This final line verifies internal scrolling.',
			].join('\n');
			textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
			textarea.scrollTop = textarea.scrollHeight;
		}
		editor.layoutContentWidget(widget);
	}
}

export default defineThemedFixtureGroup({ path: 'editor/' }, {
	SelectionAnnotationCompact: defineComponentFixture({
		labels: { kind: 'screenshot', blocksCi: true },
		expectedVisualDescriptions: [
			'A compact single-line optional-comment pill and blue numbered annotation marker are visible over the editor. The source range associated with the marker is not highlighted.',
		],
		render: context => renderSelectionAnnotation(context, false),
	}),
	SelectionAnnotationEditing: defineComponentFixture({
		labels: { kind: 'screenshot', blocksCi: true },
		expectedVisualDescriptions: [
			'An expanded annotation editor fits fully inside the editor viewport. Its multi-line textarea has a visible vertical scrollbar, and the delete, microphone, Cancel, and Save controls remain visible in a fixed bottom row. Only in this editing state, the original multi-line source range has the dark inactive-selection highlight.',
		],
		render: context => renderSelectionAnnotation(context, true),
	}),
});
