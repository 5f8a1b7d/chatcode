/* eslint-disable header/header */
import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { ACTION_ID_OPEN_CHAT } from '../../chat/browser/actions/chatActions.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';

// The Editor Area title `+` on every editor (P1-FR-043). Chat editors keep the upstream
// button and its experiment variants, which are registered with the action itself.
MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: {
		id: ACTION_ID_OPEN_CHAT,
		title: localize2('latent.editorTitle.newChat', "New Chat Editor"),
		icon: Codicon.plus,
		precondition: ChatContextKeys.enabled,
	},
	group: 'navigation',
	order: 1,
	when: ActiveEditorContext.notEqualsTo(ChatEditorInput.EditorID),
});
