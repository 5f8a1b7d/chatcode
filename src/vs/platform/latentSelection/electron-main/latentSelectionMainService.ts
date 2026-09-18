/* eslint-disable header/header */
import { BrowserWindow, screen, systemPreferences } from 'electron';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { ILatentSelectionService, ISelectionActionEvent, ISelectionBarAction, ISelectionOverlayUpdate, ISelectionSnapshot, MAX_SELECTION_LENGTH, SelectionOverlayPhase } from '../common/latentSelection.js';

const nodeRequire = createRequire(import.meta.url);
const INVALID_COORDINATE = -99999;
const MAX_OVERLAY_RESULT_LENGTH = 100_000;
const OVERLAY_WIDTH = 480;
const TOOLBAR_HEIGHT = 104;
const RESULT_HEIGHT = 340;
const WINDOW_MARGIN = 8;

interface Point {
	readonly x: number;
	readonly y: number;
}

interface NativeSelectionData {
	readonly text?: string;
	readonly programName?: string;
	readonly endTop?: Point;
	readonly endBottom?: Point;
	readonly mousePosEnd?: Point;
	readonly posLevel?: number;
}

interface NativeSelectionHook {
	on(event: 'text-selection', listener: (data: NativeSelectionData) => void): void;
	start(options?: { enableClipboard?: boolean }): boolean | void;
	stop(): boolean | void;
	cleanup(): void;
}

/** State mirrored into the overlay renderer. */
interface OverlayState {
	readonly selection: ISelectionSnapshot;
	readonly actions: readonly ISelectionBarAction[];
	readonly pinned: boolean;
	readonly hasNewer: boolean;
	readonly actionId?: string;
	readonly action?: string;
	readonly phase?: SelectionOverlayPhase;
	readonly result?: string;
	readonly details?: string;
}

/**
 * Owns the one application-wide native selection listener and the one
 * Selection Bar overlay window (P2-FR-011/012/072). The bar is draggable
 * through its grip, pinnable, and shows whatever actions the workbench
 * resolved for the selection.
 */
export class LatentSelectionMainService extends Disposable implements ILatentSelectionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidRequestAction = this._register(new Emitter<ISelectionActionEvent>());
	readonly onDidRequestAction = this._onDidRequestAction.event;

	private readonly enabledWindows = new Set<number>();
	private readonly systemActions = new Map<number, readonly ISelectionBarAction[]>();
	private hook: NativeSelectionHook | undefined;
	private overlay: BrowserWindow | undefined;
	private overlayReady = false;
	private overlayState: OverlayState | undefined;
	private overlayAnchor: Point | undefined;
	private targetWindowId: number | undefined;
	private pinned = false;
	/** The most recent selection captured while the bar was pinned. */
	private pending: { readonly selection: ISelectionSnapshot; readonly actions: readonly ISelectionBarAction[]; readonly anchor: Point; readonly windowId: number } | undefined;
	private lastSelection: { readonly text: string; readonly at: number; readonly windowId: number } | undefined;

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.windowsMainService.onDidDestroyWindow(window => {
			this.enabledWindows.delete(window.id);
			this.systemActions.delete(window.id);
			if (this.targetWindowId === window.id) {
				this.hideOverlay();
			}
			if (this.enabledWindows.size === 0) {
				this.stopHook();
			}
		}));
		this._register(lifecycleMainService.onWillShutdown(() => this.shutdown()));
	}

	async setEnabled(windowId: number, enabled: boolean): Promise<boolean> {
		if (enabled) {
			this.enabledWindows.add(windowId);
			return this.startHook();
		}
		this.enabledWindows.delete(windowId);
		if (this.targetWindowId === windowId) {
			this.hideOverlay();
		}
		if (this.enabledWindows.size === 0) {
			this.stopHook();
		}
		return false;
	}

	async setSystemActions(windowId: number, actions: readonly ISelectionBarAction[]): Promise<void> {
		this.systemActions.set(windowId, [...actions].sort((a, b) => a.order - b.order));
	}

	async showSelection(windowId: number, selection: ISelectionSnapshot, actions: readonly ISelectionBarAction[]): Promise<void> {
		// Monaco and the chat transcript own the exact selection; querying our own window through
		// OS accessibility APIs is not reliable on every platform.
		this.present(selection, [...actions].sort((a, b) => a.order - b.order), screen.getCursorScreenPoint(), windowId);
	}

	async updateOverlay(windowId: number, update: ISelectionOverlayUpdate): Promise<void> {
		if (windowId !== this.targetWindowId
			|| update.selectionId !== this.overlayState?.selection.selectionId
			|| update.actionId !== this.overlayState.actionId
			|| update.action !== this.overlayState.action) {
			return;
		}
		this.overlayState = {
			...this.overlayState,
			phase: update.phase,
			result: update.text?.slice(0, MAX_OVERLAY_RESULT_LENGTH),
			details: update.details?.slice(0, MAX_OVERLAY_RESULT_LENGTH),
		};
		this.resizeOverlay(update.phase === 'running' || update.text ? RESULT_HEIGHT : TOOLBAR_HEIGHT);
		await this.renderOverlay();
	}

	async setPinned(windowId: number, pinned: boolean): Promise<void> {
		if (windowId !== this.targetWindowId && this.targetWindowId !== undefined) {
			return;
		}
		this.applyPinned(pinned);
	}

	async hide(windowId: number): Promise<void> {
		if (windowId === this.targetWindowId) {
			this.hideOverlay();
		}
	}

	private applyPinned(pinned: boolean): void {
		this.pinned = pinned;
		if (this.overlayState) {
			this.overlayState = { ...this.overlayState, pinned, hasNewer: pinned && !!this.pending };
			void this.renderOverlay();
		}
		if (!pinned && this.pending) {
			const pending = this.pending;
			this.pending = undefined;
			this.present(pending.selection, pending.actions, pending.anchor, pending.windowId);
		}
	}

	private startHook(): boolean {
		if (this.hook) {
			return true;
		}
		if (isMacintosh) {
			try {
				if (!systemPreferences.isTrustedAccessibilityClient(true)) {
					this.logService.warn('[LatentSelection] macOS Accessibility permission has not been granted.');
				}
			} catch (error) {
				this.logService.warn('[LatentSelection] Unable to check macOS Accessibility permission.', error);
			}
		}
		let hook: NativeSelectionHook;
		try {
			const module = nodeRequire('selection-hook') as { default?: new () => NativeSelectionHook } | (new () => NativeSelectionHook);
			const Hook = typeof module === 'function' ? module : module.default;
			if (!Hook) {
				throw new Error('selection-hook did not export a constructor');
			}
			hook = new Hook();
		} catch (error) {
			this.logService.error('[LatentSelection] Unable to load selection-hook.', error);
			return false;
		}
		try {
			hook.on('text-selection', data => this.handleSystemSelection(data));
			if (hook.start({ enableClipboard: true }) === false) {
				throw new Error('selection-hook failed to start');
			}
			this.hook = hook;
			this.logService.info('[LatentSelection] System selection listener started.');
			return true;
		} catch (error) {
			this.logService.error('[LatentSelection] Unable to start selection-hook.', error);
			try {
				hook.cleanup();
			} catch {
				// The native module did not finish initializing.
			}
			return false;
		}
	}

	private stopHook(): void {
		if (!this.hook) {
			return;
		}
		try {
			this.hook.stop();
			this.hook.cleanup();
		} catch (error) {
			this.logService.error('[LatentSelection] Unable to stop selection-hook.', error);
		} finally {
			this.hook = undefined;
		}
	}

	private handleSystemSelection(data: NativeSelectionData): void {
		const raw = data.text?.trim() ?? '';
		const text = raw.slice(0, MAX_SELECTION_LENGTH);
		if (!text) {
			return;
		}
		const target = this.resolveTargetWindow();
		if (target === undefined) {
			return;
		}
		const now = Date.now();
		if (this.lastSelection?.text === text && this.lastSelection.windowId === target && now - this.lastSelection.at < 250) {
			return;
		}
		this.lastSelection = { text, at: now, windowId: target };
		const selection: ISelectionSnapshot = {
			selectionId: randomUUID(),
			source: 'system',
			text,
			capturedAt: now,
			editable: false,
			...(data.programName ? { application: data.programName } : {}),
			...(raw.length > text.length ? { truncated: true } : {}),
		};
		this.present(selection, this.systemActions.get(target) ?? [], this.resolveAnchor(data), target);
	}

	private present(selection: ISelectionSnapshot, actions: readonly ISelectionBarAction[], anchor: Point, windowId: number): void {
		if (this.pinned && this.overlayState) {
			this.pending = { selection, actions, anchor, windowId };
			this.overlayState = { ...this.overlayState, hasNewer: true };
			void this.renderOverlay();
			return;
		}
		this.targetWindowId = windowId;
		this.overlayAnchor = anchor;
		this.overlayState = { selection, actions, pinned: false, hasNewer: false };
		this.ensureOverlay();
		this.resizeOverlay(TOOLBAR_HEIGHT, true);
		this.overlay?.showInactive();
		void this.renderOverlay();
	}

	private resolveTargetWindow(): number | undefined {
		const lastActive = this.windowsMainService.getLastActiveWindow();
		if (lastActive && this.enabledWindows.has(lastActive.id)) {
			return lastActive.id;
		}
		return this.windowsMainService.getWindows()
			.filter(window => this.enabledWindows.has(window.id))
			.sort((left, right) => right.lastFocusTime - left.lastFocusTime)[0]?.id;
	}

	private resolveAnchor(data: NativeSelectionData): Point {
		const point = (data.posLevel ?? 0) >= 3 && isValidPoint(data.endBottom)
			? data.endBottom
			: isValidPoint(data.mousePosEnd) ? data.mousePosEnd : undefined;
		if (!point) {
			return screen.getCursorScreenPoint();
		}
		try {
			return screen.screenToDipPoint(point);
		} catch {
			return point;
		}
	}

	private ensureOverlay(): BrowserWindow {
		if (this.overlay && !this.overlay.isDestroyed()) {
			return this.overlay;
		}
		this.overlayReady = false;
		const overlay = this.overlay = new BrowserWindow({
			width: OVERLAY_WIDTH,
			height: TOOLBAR_HEIGHT,
			show: false,
			frame: false,
			transparent: true,
			resizable: false,
			movable: true,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			focusable: true,
			hasShadow: true,
			webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
		});
		overlay.setAlwaysOnTop(true, 'screen-saver');
		overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		overlay.webContents.on('will-navigate', (event, url) => {
			if (this.handleOverlayNavigation(url)) {
				event.preventDefault();
			}
		});
		overlay.webContents.on('did-finish-load', () => {
			this.overlayReady = true;
			void this.renderOverlay();
		});
		overlay.on('closed', () => {
			if (this.overlay === overlay) {
				this.overlay = undefined;
				this.overlayReady = false;
			}
		});
		void overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createOverlayHtml())}`);
		return overlay;
	}

	private handleOverlayNavigation(rawUrl: string): boolean {
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			return false;
		}
		if (url.protocol !== 'latent-selection:') {
			return false;
		}
		switch (url.hostname) {
			case 'dismiss':
				this.hideOverlay();
				return true;
			case 'pin':
				this.applyPinned(url.pathname === '/on');
				return true;
			case 'use-current':
				if (this.pending) {
					const pending = this.pending;
					this.pending = undefined;
					this.pinned = false;
					this.present(pending.selection, pending.actions, pending.anchor, pending.windowId);
					this.applyPinned(true);
				}
				return true;
			case 'action':
				this.runAction(decodeURIComponent(url.pathname.slice(1)));
				return true;
		}
		return true;
	}

	private runAction(action: string): void {
		if (!this.overlayState || this.targetWindowId === undefined) {
			return;
		}
		const descriptor = this.overlayState.actions.find(candidate => candidate.id === action);
		if (!descriptor) {
			return;
		}
		const actionId = randomUUID();
		this.overlayState = { ...this.overlayState, actionId, action, phase: 'running', result: undefined, details: undefined };
		if (descriptor.showsResult) {
			this.resizeOverlay(RESULT_HEIGHT);
		}
		void this.renderOverlay();
		this._onDidRequestAction.fire({ targetWindowId: this.targetWindowId, actionId, action, selection: this.overlayState.selection });
		if (!descriptor.showsResult && !this.pinned) {
			this.hideOverlay();
		}
	}

	private resizeOverlay(height: number, reposition = false): void {
		if (!this.overlay || this.overlay.isDestroyed() || !this.overlayAnchor) {
			return;
		}
		const current = this.overlay.getBounds();
		if (!reposition && this.overlay.isVisible()) {
			// Keep the user's dragged position; only grow or shrink in place (P2-FR-012).
			const display = screen.getDisplayNearestPoint({ x: current.x, y: current.y });
			const y = Math.min(current.y, display.workArea.y + display.workArea.height - height - WINDOW_MARGIN);
			this.overlay.setBounds({ x: current.x, y: Math.max(display.workArea.y + WINDOW_MARGIN, y), width: OVERLAY_WIDTH, height }, false);
			return;
		}
		const display = screen.getDisplayNearestPoint(this.overlayAnchor);
		const workArea = display.workArea;
		const x = clamp(this.overlayAnchor.x, workArea.x + WINDOW_MARGIN, workArea.x + workArea.width - OVERLAY_WIDTH - WINDOW_MARGIN);
		const below = this.overlayAnchor.y + 12;
		const y = below + height <= workArea.y + workArea.height - WINDOW_MARGIN
			? below
			: Math.max(workArea.y + WINDOW_MARGIN, this.overlayAnchor.y - height - 12);
		this.overlay.setBounds({ x: Math.round(x), y: Math.round(y), width: OVERLAY_WIDTH, height }, false);
	}

	private async renderOverlay(): Promise<void> {
		if (!this.overlayReady || !this.overlayState || !this.overlay || this.overlay.isDestroyed()) {
			return;
		}
		try {
			await this.overlay.webContents.executeJavaScript(`window.renderSelectionState(${JSON.stringify(this.overlayState).replaceAll('<', '\\u003c')})`);
		} catch (error) {
			this.logService.error('[LatentSelection] Unable to render the selection bar.', error);
		}
	}

	private hideOverlay(): void {
		if (this.overlay && !this.overlay.isDestroyed()) {
			this.overlay.hide();
		}
		this.overlayState = undefined;
		this.overlayAnchor = undefined;
		this.targetWindowId = undefined;
		this.pending = undefined;
		this.pinned = false;
	}

	private shutdown(): void {
		this.stopHook();
		if (this.overlay && !this.overlay.isDestroyed()) {
			this.overlay.destroy();
		}
		this.overlay = undefined;
	}

	override dispose(): void {
		this.shutdown();
		super.dispose();
	}
}

function isValidPoint(point: Point | undefined): point is Point {
	return !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
		&& point.x !== INVALID_COORDINATE && point.y !== INVALID_COORDINATE
		&& !(point.x === 0 && point.y === 0);
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}

function createOverlayHtml(): string {
	const labels = JSON.stringify({
		close: localize('latentSelection.close', "Close"),
		pin: localize('latentSelection.pin', "Pin"),
		unpin: localize('latentSelection.unpin', "Unpin"),
		useCurrent: localize('latentSelection.useCurrent', "Use current selection"),
		working: localize('latentSelection.working', "Working…"),
		moreDetails: localize('latentSelection.moreDetails', "More details"),
		lessDetails: localize('latentSelection.lessDetails', "Less details"),
		truncated: localize('latentSelection.truncated', "truncated"),
		noActions: localize('latentSelection.noActions', "No actions are available for this selection."),
	}).replaceAll('<', '\\u003c');
	return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:8px;background:transparent;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8e8e8}
.card{overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:10px;background:rgba(30,30,30,.97);box-shadow:0 8px 28px rgba(0,0,0,.3)}
.head{display:flex;align-items:center;gap:6px;padding:6px 8px 0}.grip{-webkit-app-region:drag;flex:1;height:18px;border-radius:4px;background:repeating-linear-gradient(90deg,rgba(255,255,255,.25) 0 2px,transparent 2px 5px);background-size:18px 4px;background-repeat:no-repeat;background-position:center;cursor:grab}
.head a{-webkit-app-region:no-drag;color:#aaa;text-decoration:none;padding:2px 6px;border-radius:5px;font-size:12px}.head a:hover{background:#3f3f46}.head a.on{color:#75beff}
.preview{padding:4px 12px 6px;color:#bdbdbd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.preview .badge{color:#e0a458;margin-left:6px}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:0 6px 7px}.bar a{color:#eee;text-decoration:none;padding:6px 9px;border-radius:6px;white-space:nowrap}.bar a:hover{background:#3f3f46}.bar .empty{color:#888;padding:6px 9px}
.newer{display:none;padding:0 12px 8px}.newer a{color:#75beff;text-decoration:none}.newer.visible{display:block}
.result{display:none;border-top:1px solid rgba(255,255,255,.1);padding:12px;max-height:210px;overflow:auto;white-space:pre-wrap;line-height:1.5;user-select:text}.result.visible{display:block}.result.running{color:#aaa}.result.failed{color:#f48771}
.details{display:none;border-top:1px solid rgba(255,255,255,.1);padding:8px 12px;color:#bdbdbd;white-space:pre-wrap;max-height:120px;overflow:auto}.details.visible{display:block}
.foot{display:none;padding:4px 12px 8px}.foot.visible{display:block}.foot a{color:#75beff;text-decoration:none;font-size:12px}
.dot{display:inline-block;width:7px;height:7px;margin-right:7px;border-radius:50%;background:#75beff;animation:pulse 1s infinite alternate}@keyframes pulse{to{opacity:.3}}
@media(prefers-color-scheme:light){body{color:#222}.card{background:rgba(250,250,250,.98);border-color:rgba(0,0,0,.13)}.preview,.result.running,.details{color:#666}.bar a,.head a{color:#222}.bar a:hover,.head a:hover{background:#e8e8e8}.grip{background-image:repeating-linear-gradient(90deg,rgba(0,0,0,.3) 0 2px,transparent 2px 5px)}}
</style></head><body><div class="card">
<div class="head"><div class="grip" title="drag"></div><a href="latent-selection://pin/on" id="pin"></a><a href="latent-selection://dismiss" id="close">×</a></div>
<div id="preview" class="preview"></div><div id="bar" class="bar"></div><div id="newer" class="newer"><a href="latent-selection://use-current" id="useCurrent"></a></div>
<div id="result" class="result"></div><div id="details" class="details"></div><div id="foot" class="foot"><a href="#" id="toggleDetails"></a></div></div>
<script>
const labels=${labels};let showDetails=false;let lastState;
document.getElementById('close').title=labels.close;document.getElementById('useCurrent').textContent=labels.useCurrent;
document.getElementById('toggleDetails').addEventListener('click',e=>{e.preventDefault();showDetails=!showDetails;if(lastState)window.renderSelectionState(lastState);});
window.renderSelectionState=state=>{lastState=state;
const pin=document.getElementById('pin');pin.textContent=state.pinned?labels.unpin:labels.pin;pin.href='latent-selection://pin/'+(state.pinned?'off':'on');pin.className=state.pinned?'on':'';
const preview=document.getElementById('preview');preview.textContent=(state.selection.application?state.selection.application+' · ':'')+state.selection.text;
if(state.selection.truncated){const b=document.createElement('span');b.className='badge';b.textContent=labels.truncated;preview.append(b);}
const bar=document.getElementById('bar');bar.replaceChildren();
if(!state.actions.length){const e=document.createElement('span');e.className='empty';e.textContent=labels.noActions;bar.append(e);}
for(const action of state.actions){const a=document.createElement('a');a.href='latent-selection://action/'+encodeURIComponent(action.id);a.textContent=action.label;a.title=action.label;bar.append(a);}
document.getElementById('newer').className='newer'+(state.hasNewer?' visible':'');
const result=document.getElementById('result');const visible=!!state.phase;result.className='result'+(visible?' visible':'')+(state.phase==='running'?' running':'')+(state.phase==='failed'?' failed':'');result.textContent='';
if(state.phase==='running'){const dot=document.createElement('span');dot.className='dot';result.append(dot,document.createTextNode(state.result||labels.working));}else if(state.result){result.textContent=state.result;}
const details=document.getElementById('details');details.className='details'+(showDetails&&state.details?' visible':'');details.textContent=state.details||'';
const foot=document.getElementById('foot');foot.className='foot'+(state.details?' visible':'');document.getElementById('toggleDetails').textContent=showDetails?labels.lessDetails:labels.moreDetails;};
</script></body></html>`;
}
