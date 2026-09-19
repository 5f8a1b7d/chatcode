/* eslint-disable header/header */
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ChatViewPaneTarget, IChatWidget, IChatWidgetService, isIChatViewViewContext } from '../../../chat/browser/chat.js';
import { ChatEditorInput } from '../../../chat/browser/widgetHosts/editor/chatEditorInput.js';

/**
 * Shows another branch session in the host that currently shows `widget`,
 * without opening a second surface (P1-FR-062).
 */
export async function switchWidgetSession(accessor: ServicesAccessor, widget: IChatWidget, sessionResource: URI): Promise<IChatWidget | undefined> {
	const chatWidgetService = accessor.get(IChatWidgetService);
	const editorService = accessor.get(IEditorService);
	const editorGroupsService = accessor.get(IEditorGroupsService);

	if (isEqual(widget.viewModel?.sessionResource, sessionResource)) {
		return widget;
	}
	if (isIChatViewViewContext(widget.viewContext)) {
		return chatWidgetService.openSession(sessionResource, ChatViewPaneTarget, { revealIfOpened: false });
	}
	const current = widget.viewModel?.sessionResource;
	if (current) {
		for (const group of editorGroupsService.groups) {
			const editor = group.editors.find(candidate => candidate instanceof ChatEditorInput && isEqual(candidate.sessionResource, current));
			if (editor) {
				await editorService.replaceEditors([{ editor, replacement: { resource: sessionResource, options: { override: ChatEditorInput.EditorID, pinned: true } } }], group);
				return chatWidgetService.getWidgetBySessionResource(sessionResource);
			}
		}
	}
	// Embedded hosts (floating composer, quick chat) re-bind through the thread service events.
	return chatWidgetService.getWidgetBySessionResource(sessionResource);
}
