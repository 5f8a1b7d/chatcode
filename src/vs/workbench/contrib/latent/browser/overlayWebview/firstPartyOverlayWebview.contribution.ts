/* eslint-disable header/header */
import { getWindow } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { clamp } from '../../../../../base/common/numbers.js';
import { hasKey } from '../../../../../base/common/types.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { GroupsOrder, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IOverlayWebview, IWebviewService } from '../../../webview/browser/webview.js';
import { getEditorGroupContentElement, getEditorGroupElement } from '../editorGroupMount.js';

const ALLOWED_OWNER = 'latentnote.latentnote-code-oss-adapter';
const MESSAGE_BRIDGE_COMMAND = '_latentnote.composer.overlayMessage';
const EDGE_MARGIN = 12;
const SNAP_DISTANCE = 24;

type SnapEdge = 'none' | 'top' | 'right' | 'bottom' | 'left';

interface OverlayBounds {
	x: number;
	y: number;
	width: number;
	height: number;
	snapEdge: SnapEdge;
}

interface OverlayCommandArgs {
	readonly owner: string;
	readonly id: string;
}

interface ShowOverlayArgs extends OverlayCommandArgs {
	readonly title: string;
	readonly html: string;
	readonly bounds?: Partial<OverlayBounds>;
	readonly editorColumn?: number;
}

interface LayoutOverlayArgs extends OverlayCommandArgs {
	readonly bounds?: Partial<OverlayBounds>;
	readonly editorColumn?: number;
}

interface PostOverlayMessageArgs extends OverlayCommandArgs {
	readonly message: unknown;
}

interface OverlayEntry {
	readonly id: string;
	readonly claimant: object;
	readonly webview: IOverlayWebview;
	readonly disposables: DisposableStore;
	anchor: HTMLElement | undefined;
	container: HTMLElement | undefined;
	html: string;
	bounds: OverlayBounds;
	editorColumn: number | undefined;
	visible: boolean;
}

class FirstPartyOverlayWebviewContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.firstPartyOverlayWebview';
	private readonly entries = new Map<string, OverlayEntry>();

	constructor(
		@IWebviewService private readonly webviewService: IWebviewService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand('_workbench.firstPartyOverlayWebview.show', (_accessor, args: ShowOverlayArgs) => this.show(args)));
		this._register(CommandsRegistry.registerCommand('_workbench.firstPartyOverlayWebview.layout', (_accessor, args: LayoutOverlayArgs) => this.layout(args)));
		this._register(CommandsRegistry.registerCommand('_workbench.firstPartyOverlayWebview.hide', (_accessor, args: OverlayCommandArgs) => this.hide(args)));
		this._register(CommandsRegistry.registerCommand('_workbench.firstPartyOverlayWebview.dispose', (_accessor, args: OverlayCommandArgs) => this.disposeEntry(args)));
		this._register(CommandsRegistry.registerCommand('_workbench.firstPartyOverlayWebview.focus', (_accessor, args: OverlayCommandArgs) => this.focus(args)));
		this._register(CommandsRegistry.registerCommand('_workbench.firstPartyOverlayWebview.postMessage', (_accessor, args: PostOverlayMessageArgs) => this.postMessage(args)));
		this._register(this.layoutService.onDidLayoutContainer(() => this.layoutVisibleEntries()));
		this._register(this.layoutService.onDidChangeActiveContainer(() => this.layoutVisibleEntries()));
	}

	override dispose(): void {
		for (const entry of this.entries.values()) { this.destroyEntry(entry); }
		this.entries.clear();
		super.dispose();
	}

	private show(args: ShowOverlayArgs): void {
		this.validate(args);
		if (typeof args.title !== 'string' || typeof args.html !== 'string') { throw new Error('Invalid first-party overlay content'); }
		let entry = this.entries.get(args.id);
		if (!entry) {
			entry = this.createEntry(args);
			this.entries.set(args.id, entry);
		}
		entry.editorColumn = Number.isInteger(args.editorColumn) ? args.editorColumn : undefined;
		entry.bounds = this.mergeBounds(entry.bounds, args.bounds);
		if (entry.html !== args.html) {
			entry.html = args.html;
			entry.webview.setHtml(args.html);
		}
		entry.webview.setTitle(args.title);
		this.attach(entry);
		entry.visible = true;
		this.layoutEntry(entry, true);
	}

	private hide(args: OverlayCommandArgs): void {
		this.validate(args);
		const entry = this.entries.get(args.id);
		if (!entry) { return; }
		entry.visible = false;
		entry.webview.release(entry.claimant);
		entry.anchor?.remove();
		entry.anchor = undefined;
		entry.container = undefined;
	}

	private layout(args: LayoutOverlayArgs): void {
		this.validate(args);
		const entry = this.entries.get(args.id);
		if (!entry || !entry.visible) { return; }
		entry.editorColumn = Number.isInteger(args.editorColumn) ? args.editorColumn : entry.editorColumn;
		entry.bounds = this.mergeBounds(entry.bounds, args.bounds);
		this.attach(entry);
		this.layoutEntry(entry, false);
	}

	private disposeEntry(args: OverlayCommandArgs): void {
		this.validate(args);
		const entry = this.entries.get(args.id);
		if (!entry) { return; }
		this.entries.delete(args.id);
		this.destroyEntry(entry);
	}

	private focus(args: OverlayCommandArgs): void {
		this.validate(args);
		this.entries.get(args.id)?.webview.focus();
	}

	private postMessage(args: PostOverlayMessageArgs): Promise<boolean> {
		this.validate(args);
		return this.entries.get(args.id)?.webview.postMessage(args.message) ?? Promise.resolve(false);
	}

	private createEntry(args: ShowOverlayArgs): OverlayEntry {
		const webview = this.webviewService.createWebviewOverlay({
			providedViewType: 'workbench.firstPartyOverlayWebview',
			title: args.title,
			options: {
				customClasses: 'first-party-overlay-webview',
				disableServiceWorker: true,
				retainContextWhenHidden: true,
				tryRestoreScrollPosition: true,
			},
			contentOptions: { allowScripts: true, allowForms: false },
			extension: { id: new ExtensionIdentifier(ALLOWED_OWNER) },
		});
		const disposables = new DisposableStore();
		const entry: OverlayEntry = {
			id: args.id,
			claimant: Object.freeze({ id: args.id }),
			webview,
			disposables,
			anchor: undefined,
			container: undefined,
			html: args.html,
			bounds: this.mergeBounds({ x: -1, y: -1, width: 680, height: 188, snapEdge: 'bottom' }, args.bounds),
			editorColumn: args.editorColumn,
			visible: false,
		};
		webview.setHtml(args.html);
		disposables.add(webview.onMessage(event => this.acceptMessage(entry, event.message)));
		disposables.add(webview.onDidDispose(() => {
			entry.anchor?.remove();
			entry.anchor = undefined;
			entry.container = undefined;
			this.entries.delete(entry.id);
		}));
		return entry;
	}

	private attach(entry: OverlayEntry): void {
		const container = this.findEditorContainer(entry.editorColumn);
		if (!container) { throw new Error('No editor content area is available for the overlay'); }
		if (entry.container === container && entry.anchor?.isConnected) { return; }
		entry.anchor?.remove();
		const anchor = container.ownerDocument.createElement('div');
		anchor.className = 'first-party-overlay-webview-anchor';
		anchor.style.position = 'fixed';
		anchor.style.zIndex = '50';
		anchor.style.pointerEvents = 'none';
		container.appendChild(anchor);
		entry.anchor = anchor;
		entry.container = container;
		entry.webview.claim(entry.claimant, getWindow(container), undefined);
		entry.webview.container.style.zIndex = '50';
		entry.webview.setAnchorElement(anchor, container);
	}

	private acceptMessage(entry: OverlayEntry, message: unknown): void {
		if (!message || typeof message !== 'object' || !hasKey(message, { type: true })) {
			void this.bridge(entry, message);
			return;
		}
		const candidate = message as { readonly type: string; readonly deltaX?: unknown; readonly deltaY?: unknown; readonly sectionId?: unknown };
		if (candidate.type === 'layout.drag') {
			if (typeof candidate.deltaX === 'number') { entry.bounds.x += candidate.deltaX; }
			if (typeof candidate.deltaY === 'number') { entry.bounds.y += candidate.deltaY; }
			entry.bounds.snapEdge = 'none';
			this.layoutEntry(entry, false);
			return;
		}
		if (candidate.type === 'layout.drag-end') {
			this.layoutEntry(entry, true);
			void this.bridge(entry, {
				type: 'layout.host-bounds',
				sectionId: candidate.sectionId,
				...entry.bounds,
			});
			return;
		}
		void this.bridge(entry, message);
	}

	private bridge(entry: OverlayEntry, message: unknown): Promise<unknown> {
		return this.commandService.executeCommand(MESSAGE_BRIDGE_COMMAND, { overlayId: entry.id, message });
	}

	private layoutVisibleEntries(): void {
		for (const entry of this.entries.values()) {
			if (!entry.visible) { continue; }
			this.attach(entry);
			this.layoutEntry(entry, false);
		}
	}

	private layoutEntry(entry: OverlayEntry, snap: boolean): void {
		const anchor = entry.anchor;
		const container = entry.container;
		if (!anchor || !container) { return; }
		const availableWidth = Math.max(1, container.clientWidth);
		const availableHeight = Math.max(1, container.clientHeight);
		const maxWidth = Math.max(320, availableWidth - EDGE_MARGIN * 2);
		const maxHeight = Math.max(150, availableHeight - EDGE_MARGIN * 2);
		entry.bounds.width = clamp(entry.bounds.width, Math.min(360, maxWidth), maxWidth);
		entry.bounds.height = clamp(entry.bounds.height, Math.min(150, maxHeight), maxHeight);
		const maxX = Math.max(EDGE_MARGIN, availableWidth - entry.bounds.width - EDGE_MARGIN);
		const maxY = Math.max(EDGE_MARGIN, availableHeight - entry.bounds.height - EDGE_MARGIN);
		if (entry.bounds.x < 0) { entry.bounds.x = Math.round((availableWidth - entry.bounds.width) / 2); }
		if (entry.bounds.y < 0) { entry.bounds.y = maxY; }
		entry.bounds.x = clamp(entry.bounds.x, EDGE_MARGIN, maxX);
		entry.bounds.y = clamp(entry.bounds.y, EDGE_MARGIN, maxY);

		if (snap) { entry.bounds.snapEdge = this.nearestEdge(entry.bounds, maxX, maxY); }
		switch (entry.bounds.snapEdge) {
			case 'top': entry.bounds.y = EDGE_MARGIN; break;
			case 'right': entry.bounds.x = maxX; break;
			case 'bottom': entry.bounds.y = maxY; break;
			case 'left': entry.bounds.x = EDGE_MARGIN; break;
		}
		const containerRect = container.getBoundingClientRect();
		anchor.style.left = `${Math.round(containerRect.left + entry.bounds.x)}px`;
		anchor.style.top = `${Math.round(containerRect.top + entry.bounds.y)}px`;
		anchor.style.width = `${Math.round(entry.bounds.width)}px`;
		anchor.style.height = `${Math.round(entry.bounds.height)}px`;
		entry.webview.setAnchorElement(anchor, container);
	}

	private nearestEdge(bounds: OverlayBounds, maxX: number, maxY: number): SnapEdge {
		const candidates: readonly [SnapEdge, number][] = [
			['top', Math.abs(bounds.y - EDGE_MARGIN)],
			['right', Math.abs(bounds.x - maxX)],
			['bottom', Math.abs(bounds.y - maxY)],
			['left', Math.abs(bounds.x - EDGE_MARGIN)],
		];
		const nearest = [...candidates].sort((a, b) => a[1] - b[1])[0];
		return nearest && nearest[1] <= SNAP_DISTANCE ? nearest[0] : 'none';
	}

	private findEditorContainer(editorColumn?: number): HTMLElement | undefined {
		const part = this.editorGroupsService.getPart(this.layoutService.activeContainer);
		const groups = part.getGroups(GroupsOrder.GRID_APPEARANCE).filter(group => {
			const element = getEditorGroupElement(group);
			return !!element && element.offsetWidth > 0 && element.offsetHeight > 0;
		});
		const requested = Number.isInteger(editorColumn) && editorColumn! > 0 ? groups[editorColumn! - 1] : undefined;
		const group = requested ?? groups.find(candidate => candidate.id === part.activeGroup.id) ?? groups[0];
		return group && getEditorGroupContentElement(group);
	}

	private mergeBounds(current: OverlayBounds, update: Partial<OverlayBounds> | undefined): OverlayBounds {
		if (!update) { return { ...current }; }
		return {
			x: typeof update.x === 'number' && Number.isFinite(update.x) ? update.x : current.x,
			y: typeof update.y === 'number' && Number.isFinite(update.y) ? update.y : current.y,
			width: typeof update.width === 'number' && Number.isFinite(update.width) ? update.width : current.width,
			height: typeof update.height === 'number' && Number.isFinite(update.height) ? update.height : current.height,
			snapEdge: isSnapEdge(update.snapEdge) ? update.snapEdge : current.snapEdge,
		};
	}

	private validate(args: OverlayCommandArgs): void {
		if (!args || args.owner !== ALLOWED_OWNER || typeof args.id !== 'string' || !args.id.startsWith('latentnote.composer.section:')) {
			throw new Error('First-party overlay access denied');
		}
	}

	private destroyEntry(entry: OverlayEntry): void {
		entry.visible = false;
		entry.webview.release(entry.claimant);
		entry.anchor?.remove();
		entry.disposables.dispose();
		entry.webview.dispose();
	}
}

function isSnapEdge(value: unknown): value is SnapEdge {
	return value === 'none' || value === 'top' || value === 'right' || value === 'bottom' || value === 'left';
}

registerWorkbenchContribution2(
	FirstPartyOverlayWebviewContribution.ID,
	FirstPartyOverlayWebviewContribution,
	WorkbenchPhase.AfterRestored,
);
