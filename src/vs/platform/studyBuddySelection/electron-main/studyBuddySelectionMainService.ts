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
import { IStudyBuddySelectionActionEvent, IStudyBuddySelectionService, IStudyBuddySystemSelection, StudyBuddySelectionAction, StudyBuddySelectionOverlayUpdate } from '../common/studyBuddySelection.js';

const nodeRequire = createRequire(import.meta.url);
const INVALID_COORDINATE = -99999;
const MAX_SELECTION_LENGTH = 50_000;
const MAX_OVERLAY_RESULT_LENGTH = 100_000;
const OVERLAY_WIDTH = 480;
const TOOLBAR_HEIGHT = 96;
const RESULT_HEIGHT = 320;
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

interface OverlayState {
	readonly selection: IStudyBuddySystemSelection;
	readonly actionId?: string;
	readonly action?: StudyBuddySelectionAction;
	readonly phase?: StudyBuddySelectionOverlayUpdate['phase'];
	readonly result?: string;
}

export class StudyBuddySelectionMainService extends Disposable implements IStudyBuddySelectionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidRequestAction = this._register(new Emitter<IStudyBuddySelectionActionEvent>());
	readonly onDidRequestAction = this._onDidRequestAction.event;

	private readonly enabledWindows = new Set<number>();
	private hook: NativeSelectionHook | undefined;
	private overlay: BrowserWindow | undefined;
	private overlayReady = false;
	private overlayState: OverlayState | undefined;
	private overlayAnchor: Point | undefined;
	private targetWindowId: number | undefined;
	private lastSelection: { readonly text: string; readonly at: number; readonly windowId: number } | undefined;

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.windowsMainService.onDidDestroyWindow(window => {
			this.enabledWindows.delete(window.id);
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

	async updateOverlay(windowId: number, update: StudyBuddySelectionOverlayUpdate): Promise<void> {
		if (windowId !== this.targetWindowId
			|| update.selectionId !== this.overlayState?.selection.selectionId
			|| update.actionId !== this.overlayState.actionId
			|| update.action !== this.overlayState.action) {
			return;
		}
		this.overlayState = {
			selection: this.overlayState.selection,
			actionId: update.actionId,
			action: update.action,
			phase: update.phase,
			result: update.text?.slice(0, MAX_OVERLAY_RESULT_LENGTH),
		};
		this.resizeAndPositionOverlay(update.phase === 'running' || update.text ? RESULT_HEIGHT : TOOLBAR_HEIGHT);
		await this.renderOverlay();
	}

	async showEditorSelection(windowId: number, text: string): Promise<void> {
		if (!this.enabledWindows.has(windowId)) {
			return;
		}
		// Monaco already owns the exact selection; querying our own Electron window through
		// OS accessibility/clipboard APIs is not reliable on all platforms.
		this.handleSelection({ text, programName: localize('studyBuddySelection.editor', "Code Editor") }, windowId);
	}

	private startHook(): boolean {
		if (this.hook) {
			return true;
		}
		if (isMacintosh) {
			try {
				if (!systemPreferences.isTrustedAccessibilityClient(true)) {
					this.logService.warn('[StudyBuddySelection] macOS Accessibility permission has not been granted.');
				}
			} catch (error) {
				this.logService.warn('[StudyBuddySelection] Unable to check macOS Accessibility permission.', error);
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
			this.logService.error('[StudyBuddySelection] Unable to load selection-hook.', error);
			return false;
		}

		try {
			hook.on('text-selection', data => this.handleSelection(data));
			if (hook.start({ enableClipboard: true }) === false) {
				throw new Error('selection-hook failed to start');
			}
			this.hook = hook;
			this.logService.info('[StudyBuddySelection] System selection listener started.');
			return true;
		} catch (error) {
			this.logService.error('[StudyBuddySelection] Unable to start selection-hook.', error);
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
			this.logService.error('[StudyBuddySelection] Unable to stop selection-hook.', error);
		} finally {
			this.hook = undefined;
		}
	}

	private handleSelection(data: NativeSelectionData, editorWindowId?: number): void {
		const text = data.text?.trim().slice(0, MAX_SELECTION_LENGTH);
		if (!text) {
			return;
		}
		const target = editorWindowId ?? this.resolveTargetWindow();
		if (target === undefined) {
			return;
		}
		const now = Date.now();
		if (this.lastSelection?.text === text && this.lastSelection.windowId === target && now - this.lastSelection.at < 250) {
			return;
		}
		this.lastSelection = { text, at: now, windowId: target };
		const selection: IStudyBuddySystemSelection = {
			selectionId: randomUUID(),
			text,
			capturedAt: now,
			...(data.programName ? { application: data.programName } : {}),
		};
		this.targetWindowId = target;
		this.overlayAnchor = this.resolveAnchor(data);
		this.overlayState = { selection };
		this.ensureOverlay();
		this.resizeAndPositionOverlay(TOOLBAR_HEIGHT);
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
			movable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			focusable: true,
			hasShadow: true,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
			},
		});
		overlay.setAlwaysOnTop(true, 'screen-saver');
		overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		overlay.webContents.on('will-navigate', (event, url) => {
			const handled = this.handleOverlayNavigation(url);
			if (handled) {
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
		if (url.protocol !== 'studybuddy-selection:') {
			return false;
		}
		if (url.hostname === 'dismiss') {
			this.hideOverlay();
			return true;
		}
		if (url.hostname !== 'action' || !this.overlayState || this.targetWindowId === undefined) {
			return true;
		}
		const action = url.pathname.slice(1) as StudyBuddySelectionAction;
		if (!isSelectionAction(action)) {
			return true;
		}
		const actionId = randomUUID();
		this.overlayState = { selection: this.overlayState.selection, actionId, action, phase: 'running' };
		this.resizeAndPositionOverlay(RESULT_HEIGHT);
		void this.renderOverlay();
		this._onDidRequestAction.fire({
			targetWindowId: this.targetWindowId,
			actionId,
			action,
			selection: this.overlayState.selection,
		});
		return true;
	}

	private resizeAndPositionOverlay(height: number): void {
		if (!this.overlay || this.overlay.isDestroyed() || !this.overlayAnchor) {
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
			await this.overlay.webContents.executeJavaScript(`window.renderSelectionState(${JSON.stringify(this.overlayState)})`);
		} catch (error) {
			this.logService.error('[StudyBuddySelection] Unable to render the selection overlay.', error);
		}
	}

	private hideOverlay(): void {
		if (this.overlay && !this.overlay.isDestroyed()) {
			this.overlay.hide();
		}
		this.overlayState = undefined;
		this.overlayAnchor = undefined;
		this.targetWindowId = undefined;
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

function isSelectionAction(value: string): value is StudyBuddySelectionAction {
	return value === 'explain' || value === 'translate' || value === 'summarize' || value === 'context';
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}

function createOverlayHtml(): string {
	const labels = JSON.stringify({
		explain: localize('studyBuddySelection.explain', "Explain"),
		translate: localize('studyBuddySelection.translate', "Translate"),
		summarize: localize('studyBuddySelection.summarize', "Summarize"),
		context: localize('studyBuddySelection.context', "Add to Context"),
		close: localize('studyBuddySelection.close', "Close"),
		working: localize('studyBuddySelection.working', "Working…"),
	}).replaceAll('<', '\\u003c');
	return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:8px;background:transparent;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8e8e8}.card{overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:10px;background:rgba(30,30,30,.97);box-shadow:0 8px 28px rgba(0,0,0,.3)}.preview{padding:9px 12px 7px;color:#bdbdbd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar{display:flex;align-items:center;gap:2px;padding:0 6px 7px}.bar a{color:#eee;text-decoration:none;padding:7px 9px;border-radius:6px;white-space:nowrap}.bar a:hover{background:#3f3f46}.bar .close{margin-left:auto;color:#aaa;font-size:17px;padding:3px 9px}.result{display:none;border-top:1px solid rgba(255,255,255,.1);padding:12px;max-height:224px;overflow:auto;white-space:pre-wrap;line-height:1.5;user-select:text}.result.visible{display:block}.result.running{color:#aaa}.dot{display:inline-block;width:7px;height:7px;margin-right:7px;border-radius:50%;background:#75beff;animation:pulse 1s infinite alternate}@keyframes pulse{to{opacity:.3}}@media(prefers-color-scheme:light){body{color:#222}.card{background:rgba(250,250,250,.98);border-color:rgba(0,0,0,.13)}.preview,.result.running{color:#666}.bar a{color:#222}.bar a:hover{background:#e8e8e8}}
</style></head><body><div class="card"><div id="preview" class="preview"></div><div class="bar"><a href="studybuddy-selection://action/explain" id="explain"></a><a href="studybuddy-selection://action/translate" id="translate"></a><a href="studybuddy-selection://action/summarize" id="summarize"></a><a href="studybuddy-selection://action/context" id="context"></a><a href="studybuddy-selection://dismiss" class="close" id="close">×</a></div><div id="result" class="result"></div></div>
<script>const labels=${labels};for(const key of ['explain','translate','summarize','context'])document.getElementById(key).textContent=labels[key];document.getElementById('close').title=labels.close;window.renderSelectionState=state=>{document.getElementById('preview').textContent=(state.selection.application?state.selection.application+' · ':'')+state.selection.text;const result=document.getElementById('result');const visible=!!state.phase;result.className='result'+(visible?' visible':'')+(state.phase==='running'?' running':'');result.textContent='';if(state.phase==='running'){const dot=document.createElement('span');dot.className='dot';result.append(dot,document.createTextNode(state.result||labels.working));}else if(state.result){result.textContent=state.result;}};</script></body></html>`;
}
