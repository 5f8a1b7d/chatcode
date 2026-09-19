/* eslint-disable header/header */
import { isHTMLElement } from '../../../../base/browser/dom.js';
import type { IEditorGroupView } from '../../../browser/parts/editor/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';

/**
 * The single place where fork surfaces depend on editor group internals.
 *
 * `IEditorGroupsService` hands out `IEditorGroup`s that are `IEditorGroupView`s at runtime, but
 * the public interface has no DOM element. Reading the element through the typed view contract
 * makes an upstream rename fail to compile here, and the runtime check makes a structural change
 * observable to the caller instead of silently mounting nothing.
 */
export function getEditorGroupElement(group: IEditorGroup): HTMLElement | undefined {
	const element: IEditorGroupView['element'] | undefined = (group as Partial<Pick<IEditorGroupView, 'element'>>).element;
	return isHTMLElement(element) ? element : undefined;
}

/** The editor content area of a group (below its tabs), or the group element when it has none. */
export function getEditorGroupContentElement(group: IEditorGroup): HTMLElement | undefined {
	const element = getEditorGroupElement(group);
	// eslint-disable-next-line no-restricted-syntax
	return element?.querySelector<HTMLElement>(':scope > .editor-container') ?? element;
}
