import { BrowserWindow, screen } from 'electron';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IAuxiliarySurfaceRenderer, IAuxiliarySurfaceRequest, IAuxiliarySurfaceResponse } from '../common/auxiliarySurface.js';

/** Bridges an isolated renderer to its owning workbench without exposing Node or arbitrary commands. */
export class AuxiliarySurface extends Disposable {
	private readonly requests = this._register(new Emitter<IAuxiliarySurfaceRequest>());
	readonly onDidRequestRendererAction = this.requests.event;
	private readonly pending = new Map<string, { windowId: number; contentsId: number }>();
	renderer: IAuxiliarySurfaceRenderer | undefined;

	configure(renderer: IAuxiliarySurfaceRenderer): void {
		this.renderer = renderer;
		this.pending.clear();
	}

	reset(): void { this.pending.clear(); }

	handleNavigation(rawUrl: string, window: BrowserWindow, targetWindowId: number | undefined): boolean {
		let url: URL;
		try { url = new URL(rawUrl); } catch { return false; }
		if (url.protocol !== 'auxiliary-surface:') { return false; }
		if (!this.renderer || targetWindowId === undefined) { return true; }
		if (url.hostname === 'resize') {
			const width = Number(url.searchParams.get('width'));
			const height = Number(url.searchParams.get('height'));
			if (Number.isInteger(width) && width >= 100 && width <= 1200 && Number.isInteger(height) && height >= 40 && height <= 1000) {
				const current = window.getBounds();
				const area = screen.getDisplayNearestPoint(current).workArea;
				const w = Math.min(width, area.width), h = Math.min(height, area.height);
				window.setBounds({ x: Math.max(area.x, Math.min(current.x, area.x + area.width - w)), y: Math.max(area.y, Math.min(current.y, area.y + area.height - h)), width: w, height: h });
			}
			return true;
		}
		const requestId = url.searchParams.get('id') ?? '';
		const action = url.searchParams.get('action') ?? '';
		const payload = url.searchParams.get('payload') ?? '{}';
		if (url.hostname !== 'request' || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId) || !/^[a-zA-Z][a-zA-Z0-9.]{0,79}$/.test(action) || payload.length > 100_000 || this.pending.has(requestId) || this.pending.size >= 32) { return true; }
		this.pending.set(requestId, { windowId: targetWindowId, contentsId: window.webContents.id });
		this.requests.fire({ targetWindowId, requestId, action, payload });
		return true;
	}

	async resolve(window: BrowserWindow | undefined, windowId: number, requestId: string, response: IAuxiliarySurfaceResponse): Promise<void> {
		const pending = this.pending.get(requestId);
		if (!pending || pending.windowId !== windowId || !window || window.isDestroyed() || pending.contentsId !== window.webContents.id) { return; }
		this.pending.delete(requestId);
		await window.webContents.executeJavaScript(`window.resolveSurfaceRequest(${JSON.stringify({ requestId, ...response }).replaceAll('<', '\\u003c')})`);
	}
}
