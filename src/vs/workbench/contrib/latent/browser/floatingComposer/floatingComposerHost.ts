/* eslint-disable header/header */
import { addDisposableListener, EventHelper, EventType, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { GlobalPointerMoveMonitor } from '../../../../../base/browser/globalPointerMoveMonitor.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IDynamicVariable } from '../../../chat/common/attachments/chatVariables.js';
import { IChatWidget } from '../../../chat/browser/chat.js';
import { IChatModel } from '../../../chat/common/model/chatModel.js';
import { ChatAgentLocation } from '../../../chat/common/constants.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { editorBackground, foreground, inputBackground } from '../../../../../platform/theme/common/colorRegistry.js';
import { ComposerModel } from '../../../chat/common/composer/composerModel.js';
import { ChatMode } from '../../../chat/common/chatModes.js';
import { ChatWidget } from '../../../chat/browser/widget/chatWidget.js';
import { renderCompactComposer, type ICompactComposerPluginActivationContext } from '../../../chat/browser/widget/input/compactComposer.js';
import './media/floatingComposer.css';

const EDGE_GAP = 12;
const FLOATING_HEIGHT_KEY = 'chat.floatingComposer.height';
const MIN_EXPANDED_HEIGHT = 280;

export interface IFloatingComposerHostCallbacks {
	/** Move the bound Thread into a Side Chat (open-location rule, origin `editorArea`). */
	readonly openInSideChat: () => Promise<void>;
	readonly prepareInput: (query: string) => Promise<{ query: string; references?: readonly IDynamicVariable[]; onRequestAccepted: () => void }>;
	readonly fixReferences: () => Promise<void>;
}

/** Owns one draggable React composer surface within an editor group container. */
export class FloatingComposerHost extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _collapsed: HTMLElement;
	private readonly _expanded: HTMLElement;
	private readonly _chatWidget: ChatWidget;
	private readonly _dragMonitor = this._register(new GlobalPointerMoveMonitor());
	private _hasCustomPosition = false;
	private _expandedHeight: number;
	private _isExpanded = false;

	get chatWidget(): IChatWidget { return this._chatWidget; }
	get isExpanded(): boolean { return this._isExpanded; }

	constructor(
		private readonly _container: HTMLElement,
		model: ComposerModel<ICompactComposerPluginActivationContext>,
		private readonly _callbacks: IFloatingComposerHostCallbacks,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._element = getWindow(this._container).document.createElement('div');
		this._element.classList.add('floating-composer-host');
		this._element.setAttribute('role', 'region');
		this._element.setAttribute('aria-label', localize('floatingComposer.region', "Floating Chat Composer"));
		this._expandedHeight = Number(this._storageService.get(FLOATING_HEIGHT_KEY, StorageScope.WORKSPACE, '520')) || 520;
		this._container.classList.add('floating-composer-container');
		this._container.appendChild(this._element);
		this._collapsed = getWindow(this._container).document.createElement('div');
		this._collapsed.classList.add('floating-composer-collapsed');
		this._element.appendChild(this._collapsed);
		this._expanded = getWindow(this._container).document.createElement('div');
		this._expanded.classList.add('floating-composer-expanded');
		this._expanded.hidden = true;
		this._element.appendChild(this._expanded);
		const header = getWindow(this._container).document.createElement('div');
		header.classList.add('floating-composer-header');
		this._expanded.appendChild(header);
		const collapse = getWindow(this._container).document.createElement('button');
		collapse.type = 'button';
		collapse.classList.add('codicon', 'codicon-chevron-down');
		collapse.title = localize('floatingComposer.collapse', "Collapse Chat");
		collapse.setAttribute('aria-label', collapse.title);
		header.appendChild(collapse);
		const handle = getWindow(this._container).document.createElement('div');
		handle.classList.add('floating-composer-resize-handle');
		handle.setAttribute('role', 'separator');
		handle.setAttribute('aria-orientation', 'horizontal');
		handle.setAttribute('aria-label', localize('floatingComposer.resize', "Resize Floating Chat"));
		handle.tabIndex = 0;
		header.appendChild(handle);
		const actions = getWindow(this._container).document.createElement('div');
		actions.classList.add('floating-composer-header-actions');
		header.appendChild(actions);
		const fixReferences = getWindow(this._container).document.createElement('button');
		fixReferences.type = 'button';
		fixReferences.textContent = localize('floatingComposer.fixReferences', "Fix References");
		actions.appendChild(fixReferences);
		const updateReferences = () => { fixReferences.hidden = model.getSnapshot().diagnostics.length === 0; };
		this._register(model.onDidChange(updateReferences));
		updateReferences();
		this._register(addDisposableListener(fixReferences, EventType.CLICK, () => void this._callbacks.fixReferences()));
		const retry = getWindow(this._container).document.createElement('button');
		retry.type = 'button';
		retry.classList.add('codicon', 'codicon-refresh');
		retry.title = localize('floatingComposer.retry', "Retry Last Request");
		retry.setAttribute('aria-label', retry.title);
		actions.appendChild(retry);
		const move = getWindow(this._container).document.createElement('button');
		move.type = 'button';
		move.classList.add('codicon', 'codicon-arrow-right');
		move.title = localize('floatingComposer.move', "Move Chat to Secondary Side Bar");
		move.setAttribute('aria-label', move.title);
		actions.appendChild(move);
		const chatBody = getWindow(this._container).document.createElement('div');
		chatBody.classList.add('floating-composer-chat-body');
		this._expanded.appendChild(chatBody);
		const scopedInstantiationService = this._register(instantiationService.createChild(new ServiceCollection([
			IContextKeyService, this._register(contextKeyService.createScoped(chatBody))
		])));
		this._chatWidget = this._register(scopedInstantiationService.createInstance(
			ChatWidget,
			ChatAgentLocation.Chat,
			{ isQuickChat: true },
			{ autoScroll: true, renderStyle: 'compact', enableFind: true, renderFollowups: true, defaultMode: ChatMode.Ask, prepareInput: query => this._callbacks.prepareInput(query) },
			{ listForeground: foreground, listBackground: editorBackground, overlayBackground: editorBackground, inputEditorBackground: inputBackground, resultEditorBackground: editorBackground },
		));
		this._chatWidget.render(chatBody);
		this._chatWidget.setVisible(false);
		this._register(addDisposableListener(collapse, EventType.CLICK, () => this.collapse()));
		this._register(addDisposableListener(retry, EventType.CLICK, () => void this._chatWidget.rerunLastRequest()));
		this._register(addDisposableListener(move, EventType.CLICK, () => void this._callbacks.openInSideChat()));
		const expand = getWindow(this._container).document.createElement('button');
		expand.classList.add('floating-composer-expand', 'codicon', 'codicon-chevron-up');
		expand.title = localize('floatingComposer.expand', "Expand Chat");
		expand.setAttribute('aria-label', expand.title);
		this._element.appendChild(expand);
		this._register(addDisposableListener(expand, EventType.CLICK, () => this.expand()));
		this._register(addDisposableListener(handle, EventType.POINTER_DOWN, event => this._startResize(event)));
		this._register(addDisposableListener(handle, EventType.KEY_DOWN, event => {
			if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
				EventHelper.stop(event, true);
				this._setExpandedHeight(this._expandedHeight + (event.key === 'ArrowUp' ? 40 : -40), true);
			}
		}));

		this._register(toDisposable(() => {
			this._element.remove();
			this._container.classList.remove('floating-composer-container');
		}));
		const renderer = this._register(new MutableDisposable<IDisposable>());
		let disposed = false;
		this._register(toDisposable(() => disposed = true));
		void renderCompactComposer(this._collapsed, model, () => {
			this.expand();
			const editor = this._chatWidget.inputPart.inputEditor;
			const inputModel = editor.getModel();
			if (inputModel) { editor.setPosition(inputModel.getPositionAt(inputModel.getValueLength())); }
			editor.trigger('latent.context', 'editor.action.triggerSuggest', {});
		}).then(disposable => {
			if (disposed) {
				disposable.dispose();
			} else {
				renderer.value = disposable;
			}
		}, onUnexpectedError);
		this._register(addDisposableListener(this._element, EventType.POINTER_DOWN, event => this._startDrag(event)));

		const resizeObserver = new (getWindow(this._container).ResizeObserver)(() => this._clampCurrentPosition());
		resizeObserver.observe(this._container);
		resizeObserver.observe(this._element);
		this._register(toDisposable(() => resizeObserver.disconnect()));
	}

	/** Shows or hides the whole surface; used when the active Tab is not editable (P1-FR-011). */
	setVisible(visible: boolean): void {
		this._element.hidden = !visible;
		if (!visible) {
			this.collapse();
		}
	}

	expand(): void {
		if (this._isExpanded) {
			return;
		}
		this._isExpanded = true;
		this._collapsed.hidden = true;
		this._expanded.hidden = false;
		this._chatWidget.setVisible(true);
		this._setExpandedHeight(this._expandedHeight);
		this._chatWidget.focusInput();
	}

	collapse(): void {
		if (!this._isExpanded) {
			return;
		}
		this._isExpanded = false;
		this._chatWidget.setVisible(false);
		this._expanded.hidden = true;
		this._collapsed.hidden = false;
	}

	unboundForMove(): void {
		this.collapse();
		this._chatWidget.setModel(undefined);
	}

	bindModel(model: IChatModel | undefined): void {
		if (model !== this._chatWidget.viewModel?.model) {
			this._chatWidget.setModel(model);
		}
	}

	private _setExpandedHeight(height: number, persist = false): void {
		const maximum = Math.max(MIN_EXPANDED_HEIGHT, this._container.clientHeight - EDGE_GAP * 2);
		this._expandedHeight = Math.min(maximum, Math.max(MIN_EXPANDED_HEIGHT, height));
		if (persist) {
			this._storageService.store(FLOATING_HEIGHT_KEY, String(this._expandedHeight), StorageScope.WORKSPACE, StorageTarget.USER);
		}
		this._expanded.style.height = `${this._expandedHeight}px`;
		if (this._isExpanded) {
			this._chatWidget.layout(this._expandedHeight - 36, this._expanded.clientWidth);
		}
	}

	private _startResize(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}
		EventHelper.stop(event, true);
		const startY = event.clientY;
		const startHeight = this._expandedHeight;
		this._dragMonitor.startMonitoring(this._element, event.pointerId, event.buttons, moveEvent => {
			this._setExpandedHeight(startHeight + startY - moveEvent.clientY);
		}, () => this._setExpandedHeight(this._expandedHeight, true));
	}

	private _startDrag(event: PointerEvent): void {
		if (event.button !== 0 || event.buttons !== 1) {
			return;
		}
		const target = event.target;
		if (!isHTMLElement(target) || target.closest('button, textarea, input, select, a, [role="button"], [role="menuitem"], .floating-composer-expanded')) {
			return;
		}

		EventHelper.stop(event, true);
		const containerRect = this._container.getBoundingClientRect();
		const composerRect = this._element.getBoundingClientRect();
		const startX = event.clientX;
		const startY = event.clientY;
		const startLeft = composerRect.left - containerRect.left;
		const startTop = composerRect.top - containerRect.top;

		this._element.classList.add('dragging');
		this._dragMonitor.startMonitoring(this._element, event.pointerId, event.buttons, moveEvent => {
			this._hasCustomPosition = true;
			this._setPosition(startLeft + moveEvent.clientX - startX, startTop + moveEvent.clientY - startY);
		}, () => this._element.classList.remove('dragging'));
	}

	private _setPosition(left: number, top: number): void {
		const maxLeft = Math.max(EDGE_GAP, this._container.clientWidth - this._element.offsetWidth - EDGE_GAP);
		const maxTop = Math.max(EDGE_GAP, this._container.clientHeight - this._element.offsetHeight - EDGE_GAP);
		this._element.style.insetInlineStart = `${Math.min(maxLeft, Math.max(EDGE_GAP, left))}px`;
		this._element.style.top = `${Math.min(maxTop, Math.max(EDGE_GAP, top))}px`;
		this._element.style.bottom = 'auto';
		this._element.style.transform = 'none';
	}

	private _clampCurrentPosition(): void {
		if (!this._hasCustomPosition) {
			return;
		}
		const containerRect = this._container.getBoundingClientRect();
		const composerRect = this._element.getBoundingClientRect();
		this._setPosition(composerRect.left - containerRect.left, composerRect.top - containerRect.top);
	}
}
