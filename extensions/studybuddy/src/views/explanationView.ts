import * as vscode from 'vscode';
import type { ExplanationState } from '../learning/explanationState';

type ViewMessage =
	| { readonly type: 'cancel' }
	| { readonly type: 'save' }
	| { readonly type: 'setToken' };

export class ExplanationViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private binding: vscode.Disposable | undefined;
	private state: ExplanationState = { phase: 'idle' };

	constructor(private readonly onMessage: (message: ViewMessage) => void) { }

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.html();
		this.binding?.dispose();
		const messages = view.webview.onDidReceiveMessage(message => {
			if (isViewMessage(message)) {
				this.onMessage(message);
			}
		});
		const disposed = view.onDidDispose(() => {
			if (this.view === view) {
				this.view = undefined;
				this.binding?.dispose();
				this.binding = undefined;
			}
		});
		this.binding = vscode.Disposable.from(messages, disposed);
		void this.postState();
	}

	setState(state: ExplanationState): void {
		this.state = state;
		void this.postState();
	}

	dispose(): void {
		this.binding?.dispose();
		this.binding = undefined;
		this.view = undefined;
	}

	private async postState(): Promise<void> {
		await this.view?.webview.postMessage({ type: 'state', state: this.state });
	}

	private html(): string {
		const nonce = createNonce();
		const labels = JSON.stringify({
			idle: vscode.l10n.t('Select text, then choose a Study Buddy action.'),
			running: vscode.l10n.t('Explaining selection…'),
			succeeded: vscode.l10n.t('Explanation complete'),
			failed: vscode.l10n.t('Explanation failed'),
			cancelled: vscode.l10n.t('Explanation cancelled'),
			selection: vscode.l10n.t('Selected text'),
			answer: vscode.l10n.t('Explanation'),
			cancel: vscode.l10n.t('Cancel'),
			save: vscode.l10n.t('Add to Memory'),
			saving: vscode.l10n.t('Saving…'),
			saved: vscode.l10n.t('Added to memory'),
			memoryFailed: vscode.l10n.t('Memory save failed'),
			setToken: vscode.l10n.t('Set Access Token'),
		}).replaceAll('<', '\\u003c');
		return `<!doctype html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<style nonce="${nonce}">
		:root { color-scheme: light dark; }
		body { margin: 0; padding: 14px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
		.status { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
		.status.running::before { content: ''; width: 10px; height: 10px; border: 2px solid var(--vscode-progressBar-background); border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
		section { margin: 0 0 16px; }
		h2 { margin: 0 0 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
		pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-font-family); line-height: 1.5; }
		.selection { padding: 9px 10px; border-left: 2px solid var(--vscode-textBlockQuote-border); background: var(--vscode-textBlockQuote-background); color: var(--vscode-descriptionForeground); max-height: 120px; overflow: auto; }
		.answer { user-select: text; }
		.actions { display: flex; gap: 8px; flex-wrap: wrap; }
		button { border: 1px solid var(--vscode-button-border, transparent); padding: 5px 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
		button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		button:disabled { opacity: .6; cursor: default; }
		.message { margin-top: 10px; color: var(--vscode-descriptionForeground); }
		.message.error { color: var(--vscode-errorForeground); }
		[hidden] { display: none !important; }
		@keyframes spin { to { transform: rotate(360deg); } }
	</style>
</head>
<body>
	<div id="status" class="status"></div>
	<section id="selectionSection" hidden><h2 id="selectionLabel"></h2><pre id="selection" class="selection"></pre></section>
	<section id="answerSection" hidden><h2 id="answerLabel"></h2><pre id="answer" class="answer"></pre></section>
	<div class="actions">
		<button id="cancel" class="secondary" type="button" hidden></button>
		<button id="save" type="button" hidden></button>
		<button id="setToken" class="secondary" type="button"></button>
	</div>
	<div id="message" class="message" hidden></div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const labels = ${labels};
		const elements = {
			status: document.getElementById('status'), selectionSection: document.getElementById('selectionSection'),
			selectionLabel: document.getElementById('selectionLabel'), selection: document.getElementById('selection'),
			answerSection: document.getElementById('answerSection'), answerLabel: document.getElementById('answerLabel'),
			answer: document.getElementById('answer'), cancel: document.getElementById('cancel'),
			save: document.getElementById('save'), setToken: document.getElementById('setToken'), message: document.getElementById('message'),
		};
		elements.selectionLabel.textContent = labels.selection; elements.answerLabel.textContent = labels.answer;
		elements.cancel.textContent = labels.cancel; elements.save.textContent = labels.save; elements.setToken.textContent = labels.setToken;
		elements.cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
		elements.save.addEventListener('click', () => vscode.postMessage({ type: 'save' }));
		elements.setToken.addEventListener('click', () => vscode.postMessage({ type: 'setToken' }));
		function render(state) {
			elements.status.textContent = labels[state.phase]; elements.status.className = 'status ' + state.phase;
			const hasRequest = state.phase !== 'idle';
			elements.selectionSection.hidden = !hasRequest; elements.selection.textContent = hasRequest ? state.snapshot.text : '';
			elements.answerSection.hidden = !hasRequest || !state.text; elements.answer.textContent = hasRequest ? state.text : '';
			elements.cancel.hidden = state.phase !== 'running';
			const canSave = state.phase === 'succeeded';
			elements.save.hidden = !canSave || state.memory === 'saved'; elements.save.disabled = canSave && state.memory === 'saving';
			elements.save.textContent = canSave && state.memory === 'saving' ? labels.saving : labels.save;
			let message = ''; let error = false;
			if (state.phase === 'failed' || state.phase === 'cancelled') { message = state.message; error = state.phase === 'failed'; }
			if (canSave && state.memory === 'saved') { message = state.memoryMessage || labels.saved; }
			if (canSave && state.memory === 'failed') { message = state.memoryMessage || labels.memoryFailed; error = true; }
			elements.message.hidden = !message; elements.message.textContent = message; elements.message.className = 'message' + (error ? ' error' : '');
		}
		window.addEventListener('message', event => { if (event.data && event.data.type === 'state') { render(event.data.state); } });
	</script>
</body>
</html>`;
	}
}

function isViewMessage(value: unknown): value is ViewMessage {
	if (typeof value !== 'object' || value === null || !('type' in value)) {
		return false;
	}
	return value.type === 'cancel' || value.type === 'save' || value.type === 'setToken';
}

function createNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let index = 0; index < 32; index += 1) {
		value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return value;
}
