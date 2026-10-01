/** The auxiliary surface exposes one bounded message channel, never Node or arbitrary IPC. */
(function () {
	const { ipcRenderer, contextBridge } = require('electron');
	contextBridge.exposeInMainWorld('auxiliarySurface', {
		send(message: string): void {
			if (typeof message !== 'string' || message.length > 500_000) {
				throw new Error('Invalid auxiliary surface message');
			}
			ipcRenderer.send('vscode:auxiliarySurface', message);
		}
	});
}());
