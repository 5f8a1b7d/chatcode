/* eslint-disable header/header */
import { IChatService } from '../../../chat/common/chatService/chatService.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { platformLocale } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { registerMainProcessRemoteService } from '../../../../../platform/ipc/electron-browser/services.js';
import { IFloatingWindowState, ILatentFloatingWindowService, LATENT_FLOATING_WINDOW_CHANNEL } from '../../../../../platform/latentFloatingWindow/common/latentFloatingWindow.js';
import { LatentFloatingWindowChannelClient } from '../../../../../platform/latentFloatingWindow/common/latentFloatingWindowIpc.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IChatWidget } from '../../../chat/browser/chat.js';
import { LatentSettings } from '../../browser/latentConfiguration.js';
import { ISideChatOpener } from '../../browser/sideChat/sideChatOpener.js';
import { IThreadService } from '../../common/threads.js';
import { IVoiceConnection, IVoiceTranscript, LatentVoiceSession } from './latentVoiceSession.js';

registerMainProcessRemoteService(ILatentFloatingWindowService, LATENT_FLOATING_WINDOW_CHANNEL, { channelClientCtor: LatentFloatingWindowChannelClient });

/** Workbench side of the Floating Window: thread creation in the editor area and full-duplex voice (P2-FR-062/063). */
class FloatingWindowContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.latentFloatingWindow';

	private readonly voice = this._register(new MutableDisposable<LatentVoiceSession>());
	private threadId: string | undefined;
	private widget: IChatWidget | undefined;
	private transcript: { role: 'user' | 'assistant'; text: string; final: boolean }[] = [];

	constructor(
		@ILatentFloatingWindowService private readonly floatingWindowService: ILatentFloatingWindowService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISideChatOpener private readonly sideChatOpener: ISideChatOpener,
		@IChatService private readonly chatService: IChatService,
		@IThreadService private readonly threadService: IThreadService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(LatentSettings.FloatingWindowEnabled)) {
				void this.syncEnabled();
			}
		}));
		this._register(this.floatingWindowService.onDidRequestNewThread(event => {
			if (event.targetWindowId === this.nativeHostService.windowId) {
				void this.newThread(event.text).catch(error => this.logService.error('[LatentFloatingWindow] New thread failed.', error));
			}
		}));
		this._register(this.floatingWindowService.onDidToggleVoice(event => {
			if (event.targetWindowId === this.nativeHostService.windowId) {
				void this.toggleVoice().catch(error => this.logService.error('[LatentFloatingWindow] Voice failed.', error));
			}
		}));
		void this.syncEnabled();
	}

	private async syncEnabled(): Promise<void> {
		const enabled = this.configurationService.getValue<boolean>(LatentSettings.FloatingWindowEnabled) !== false;
		try {
			await this.floatingWindowService.setEnabled(this.nativeHostService.windowId, enabled);
			if (enabled) {
				await this.publishState();
			}
		} catch (error) {
			this.logService.error('[LatentFloatingWindow] Unable to change the floating window state.', error);
		}
	}

	private async publishState(partial: Partial<IFloatingWindowState> = {}): Promise<void> {
		const thread = this.threadId ? this.threadService.getThread(this.threadId) : undefined;
		const voice = this.voice.value?.state;
		const state: IFloatingWindowState = {
			threadTitle: thread?.title,
			voice: voice === 'listening' || voice === 'speaking' || voice === 'connecting' || voice === 'error' ? voice : 'off',
			transcript: this.transcript.slice(-4),
			...partial,
		};
		await this.floatingWindowService.setState(this.nativeHostService.windowId, state);
	}

	/** Opens a new Thread in the editor area of this window and sends the typed text as its first message (P2-FR-062). */
	private async newThread(text: string): Promise<void> {
		await this.hostService.focus(mainWindow);
		const widget = await this.sideChatOpener.openNew('floatingWindow', { focusInput: true });
		if (!widget?.viewModel) {
			return;
		}
		this.widget = widget;
		this.threadId = this.threadService.getThreadBySession(widget.viewModel.sessionResource)?.id;
		if (text.trim()) {
			await widget.acceptInput(text.trim());
		}
		await this.publishState();
	}

	/** Toggles full-duplex voice against the `realtimeVoice` binding (P2-FR-063). */
	private async toggleVoice(): Promise<void> {
		if (this.voice.value) {
			await this.stopVoice();
			return;
		}
		let connection: IVoiceConnection | undefined;
		try {
			connection = await this.commandService.executeCommand<IVoiceConnection>('latent.provider.resolveRealtimeConnection');
		} catch (error) {
			this.logService.warn('[LatentFloatingWindow] No realtime voice binding.', error);
		}
		if (!connection) {
			await this.publishState({ voice: 'error', statusText: localize('latentFloatingWindow.noRealtime', "Configure a realtime voice provider") });
			await this.commandService.executeCommand('latent.provider.guide', 'realtimeVoice', localize('latentFloatingWindow.caller', "Floating window voice"));
			return;
		}
		if (!this.threadId) {
			await this.newThread('');
		}
		const session = new LatentVoiceSession(connection, { language: platformLocale });
		this.voice.value = session;
		this.transcript = [];
		this._register(session.onDidChangeState(state => {
			void this.publishState(state === 'closed' ? { voice: 'off' } : {});
			if (state === 'closed' && this.voice.value === session) {
				this.finishVoice();
			}
		}));
		this._register(session.onDidTranscript(transcript => this.onTranscript(transcript)));
		try {
			await session.start();
		} catch (error) {
			this.voice.clear();
			this.notificationService.error(error instanceof Error ? error.message : String(error));
			await this.publishState({ voice: 'error' });
		}
	}

	private onTranscript(transcript: IVoiceTranscript): void {
		const last = this.transcript[this.transcript.length - 1];
		if (last && last.role === transcript.role && !last.final) {
			last.text = transcript.text;
			last.final = transcript.final;
		} else {
			this.transcript.push({ ...transcript });
		}
		void this.publishState();
	}

	private async stopVoice(): Promise<void> {
		await this.voice.value?.stop();
		this.voice.clear();
		this.finishVoice();
	}

	/** Save the spoken exchange as completed turns without sending it to a text model. */
	private finishVoice(): void {
		const resource = this.widget?.viewModel?.sessionResource;
		if (resource) {
			let user: string[] = [];
			let assistant: string[] = [];
			const flush = () => {
				if (user.length || assistant.length) {
					this.chatService.addCompleteRequest(resource, user.join('\n') || localize('latentFloatingWindow.voiceTurn', "Voice conversation"), undefined, 0, { message: assistant.join('\n') });
					user = []; assistant = [];
				}
			};
			for (const turn of this.transcript.filter(item => item.text.trim())) {
				if (turn.role === 'user') { if (assistant.length) { flush(); } user.push(turn.text); }
				else { assistant.push(turn.text); }
			}
			flush();
		}
		this.transcript = [];
		void this.publishState({ voice: 'off' });
	}

}

registerWorkbenchContribution2(FloatingWindowContribution.ID, FloatingWindowContribution, WorkbenchPhase.Eventually);
