/* eslint-disable header/header */
import { BrowserWindow, screen } from 'electron';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IStateService } from '../../state/node/state.js';
import { IWindowsMainService, OpenContext } from '../../windows/electron-main/windows.js';
import { FLOATING_WINDOW_HEIGHT, FLOATING_WINDOW_WIDTH, IFloatingNewThreadEvent, IFloatingVoiceEvent, IFloatingWindowState, ILatentFloatingWindowService } from '../common/latentFloatingWindow.js';

const positionKey = 'latent.floatingWindow.position';

/**
 * Owns the one system-level Floating Window (P2-FR-060..065): fixed size,
 * always on top, draggable by its header, not resizable, not closable from
 * the window itself. It can be disabled only through the application setting
 * that the workbench forwards with `setEnabled`.
 */
export class LatentFloatingWindowMainService extends Disposable implements ILatentFloatingWindowService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidRequestNewThread = this._register(new Emitter<IFloatingNewThreadEvent>());
	readonly onDidRequestNewThread = this._onDidRequestNewThread.event;
	private readonly _onDidToggleVoice = this._register(new Emitter<IFloatingVoiceEvent>());
	readonly onDidToggleVoice = this._onDidToggleVoice.event;

	private window: BrowserWindow | undefined;
	private ready = false;
	private enabled = false;
	private shuttingDown = false;
	private state: IFloatingWindowState = { voice: 'off' };

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IStateService private readonly stateService: IStateService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(lifecycleMainService.onBeforeShutdown(() => { this.shuttingDown = true; }));
		this._register(lifecycleMainService.onWillShutdown(() => {
			this.shuttingDown = true;
			this.destroy();
		}));
	}

	async isEnabled(): Promise<boolean> {
		return this.enabled;
	}

	async setEnabled(_windowId: number, enabled: boolean): Promise<void> {
		this.enabled = enabled;
		if (enabled) {
			this.ensureWindow().show();
		} else {
			this.destroy();
		}
	}

	async setState(_windowId: number, state: IFloatingWindowState): Promise<void> {
		this.state = state;
		await this.render();
	}

	private ensureWindow(): BrowserWindow {
		if (this.window && !this.window.isDestroyed()) {
			return this.window;
		}
		this.ready = false;
		const saved = this.stateService.getItem<{ x: number; y: number }>(positionKey);
		const window = this.window = new BrowserWindow({
			width: FLOATING_WINDOW_WIDTH,
			height: FLOATING_WINDOW_HEIGHT,
			minWidth: FLOATING_WINDOW_WIDTH,
			maxWidth: FLOATING_WINDOW_WIDTH,
			...(saved ? this.clampToDisplay(saved) : {}),
			show: false,
			frame: false,
			transparent: false,
			resizable: false,
			movable: true,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			closable: false,
			skipTaskbar: true,
			hasShadow: true,
			title: localize('latentFloatingWindow.title', "Latent"),
			webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
		});
		window.setAlwaysOnTop(true, 'floating');
		if (isMacintosh) {
			window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		}
		window.on('close', event => {
			// Not closable from the window itself while enabled (P2-FR-060).
			if (this.enabled && !this.shuttingDown) {
				event.preventDefault();
			}
		});
		window.on('moved', () => {
			const [x, y] = window.getPosition();
			this.stateService.setItem(positionKey, { x, y });
		});
		window.on('closed', () => {
			if (this.window === window) {
				this.window = undefined;
				this.ready = false;
			}
		});
		window.webContents.on('will-navigate', (event, url) => {
			if (this.handleNavigation(url)) {
				event.preventDefault();
			}
		});
		window.webContents.on('did-finish-load', () => {
			this.ready = true;
			void this.render();
		});
		void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createFloatingWindowHtml())}`);
		return window;
	}

	private clampToDisplay(position: { x: number; y: number }): { x: number; y: number } {
		const display = screen.getDisplayNearestPoint(position);
		const area = display.workArea;
		return {
			x: Math.min(Math.max(position.x, area.x), area.x + area.width - FLOATING_WINDOW_WIDTH),
			y: Math.min(Math.max(position.y, area.y), area.y + area.height - FLOATING_WINDOW_HEIGHT),
		};
	}

	private targetWindowId(): number | undefined {
		return this.windowsMainService.getLastActiveWindow()?.id ?? this.windowsMainService.getWindows()[0]?.id;
	}

	private handleNavigation(rawUrl: string): boolean {
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			return false;
		}
		if (url.protocol !== 'latent-floating:') {
			return false;
		}
		const targetWindowId = this.targetWindowId();
		if (targetWindowId === undefined) {
			this.logService.warn('[LatentFloatingWindow] No workbench window is open to receive the request.');
			void this.windowsMainService.openEmptyWindow({ context: OpenContext.API });
			return true;
		}
		if (url.hostname === 'new-thread') {
			this._onDidRequestNewThread.fire({ targetWindowId, text: url.searchParams.get('text') ?? '' });
		} else if (url.hostname === 'voice') {
			this._onDidToggleVoice.fire({ targetWindowId });
		}
		return true;
	}

	private async render(): Promise<void> {
		if (!this.ready || !this.window || this.window.isDestroyed()) {
			return;
		}
		const height = this.state.transcript?.some(turn => turn.text.length > 0) ? 116 : FLOATING_WINDOW_HEIGHT;
		this.window.setSize(FLOATING_WINDOW_WIDTH, height);
		try {
			await this.window.webContents.executeJavaScript(`window.renderFloatingState(${JSON.stringify(this.state).replaceAll('<', '\\u003c')})`);
		} catch (error) {
			this.logService.error('[LatentFloatingWindow] Unable to render the floating window.', error);
		}
	}

	private destroy(): void {
		if (this.window && !this.window.isDestroyed()) {
			this.window.destroy();
		}
		this.window = undefined;
		this.ready = false;
	}

	override dispose(): void {
		this.destroy();
		super.dispose();
	}
}

function createFloatingWindowHtml(): string {
	const labels = JSON.stringify({
		placeholder: localize('latentFloatingWindow.placeholder', "Ask anything…"),
		newThread: localize('latentFloatingWindow.newThread', "New Thread"),
		voice: localize('latentFloatingWindow.voice', "Voice"),
		stopVoice: localize('latentFloatingWindow.stopVoice', "Stop"),
		off: localize('latentFloatingWindow.voiceOff', "Voice off"),
		connecting: localize('latentFloatingWindow.connecting', "Connecting…"),
		listening: localize('latentFloatingWindow.listening', "Listening"),
		speaking: localize('latentFloatingWindow.speaking', "Speaking"),
		error: localize('latentFloatingWindow.error', "Voice unavailable"),
	}).replaceAll('<', '\\u003c');
	return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}
body{display:flex;flex-direction:column;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#1f1f1f;color:#e8e8e8;border:1px solid rgba(255,255,255,.14);border-radius:10px}
.head{-webkit-app-region:drag;display:flex;align-items:center;gap:8px;padding:6px 10px;height:30px;font-size:12px;color:#bdbdbd}
.head .dot{width:8px;height:8px;border-radius:50%;background:#666}.head .dot.listening{background:#4caf50}.head .dot.speaking{background:#75beff}.head .dot.connecting{background:#e0a458}.head .dot.error{background:#f48771}
.head .title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.body{display:flex;flex-direction:column;gap:6px;padding:0 10px 8px}
form{display:flex;gap:6px}input{flex:1;min-width:0;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.14);background:#2a2a2a;color:inherit;font:inherit}
button{-webkit-app-region:no-drag;padding:6px 10px;border-radius:6px;border:0;background:#3f3f46;color:#eee;font:inherit;cursor:pointer}button.primary{background:#0e639c}button.active{background:#4caf50;color:#111}
.transcript:empty{display:none}.transcript{height:30px;overflow:auto;font-size:12px;color:#bdbdbd;white-space:nowrap;text-overflow:ellipsis}
@media(prefers-color-scheme:light){body{background:#fafafa;color:#222;border-color:rgba(0,0,0,.13)}input{background:#fff;border-color:rgba(0,0,0,.15)}button{background:#e8e8e8;color:#222}button.primary{background:#0e639c;color:#fff}.head,.transcript{color:#666}}
</style></head><body>
<div class="head"><span id="dot" class="dot"></span><span id="title" class="title"></span><span id="status"></span></div>
<div class="body"><form id="form"><input id="text" autocomplete="off"><button class="primary" type="submit" id="new"></button><button type="button" id="voice"></button></form><div id="transcript" class="transcript"></div></div>
<script>
const labels=${labels};let state={voice:'off'};
const text=document.getElementById('text');text.placeholder=labels.placeholder;
document.getElementById('new').textContent=labels.newThread;
document.getElementById('form').addEventListener('submit',e=>{e.preventDefault();location.href='latent-floating://new-thread?text='+encodeURIComponent(text.value);text.value='';});
document.getElementById('voice').addEventListener('click',()=>{location.href='latent-floating://voice';});
window.renderFloatingState=next=>{state=next;document.getElementById('dot').className='dot '+state.voice;document.getElementById('title').textContent=state.threadTitle||'';document.getElementById('status').textContent=state.statusText||labels[state.voice]||'';
const voice=document.getElementById('voice');voice.textContent=state.voice==='off'||state.voice==='error'?labels.voice:labels.stopVoice;voice.className=state.voice==='listening'||state.voice==='speaking'?'active':'';
const transcript=document.getElementById('transcript');transcript.textContent=(state.transcript||[]).map(t=>(t.role==='user'?'You: ':'AI: ')+t.text).join('  ·  ');transcript.scrollLeft=transcript.scrollWidth;};
</script></body></html>`;
}
