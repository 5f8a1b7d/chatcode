import * as vscode from 'vscode';
import type { IAsrOptions, ICapabilityBinding, ICapabilityRequest, IExternalProvider, IImageUnderstandOptions, ILatentProviderApi, IRealtimeConnection, IRealtimeSessionOptions, IRealtimeVoiceSession, ITextGenerateOptions, ITtsOptions, ProviderCapability } from '../api';
import { CapabilityUnavailableError, providerCapabilities } from '../api';
import { ProviderManager } from '../manager/manager';
import { synthesizeSpeech, transcribeAudio } from './audio';
import { chooseBinding, computeBindings } from './bindings';
import { createRealtimeBridge } from './realtimeBridge';
import { isMoshi } from './realtimeWire';
import { TranscribedVoiceSession } from './realtimeTranscription';
import { RealtimeVoiceSession } from './realtime';
import { requestText } from './text';

/** Implements the unified capability-selection model (spec 02 §2.5) on top of the provider store. */
export class CapabilityService implements ILatentProviderApi, vscode.Disposable {
	readonly version = 1;
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeBindings = this.changeEmitter.event;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly voiceBridges = new Set<vscode.Disposable>();
	private secretPresence = new Map<string, boolean>();

	constructor(private readonly manager: ProviderManager) {
		this.disposables.push(this.changeEmitter, manager.onDidChange(() => {
			this.secretPresence.clear();
			this.changeEmitter.fire();
		}));
	}

	/** Every binding per capability, used by the manager's capability matrix. */
	async matrix(): Promise<Record<ProviderCapability, ICapabilityBinding[]>> {
		const catalog = this.manager.getCatalog();
		const result = Object.fromEntries(providerCapabilities.map(capability => [capability, [] as ICapabilityBinding[]])) as Record<ProviderCapability, ICapabilityBinding[]>;
		if (!catalog) {
			return result;
		}
		const store = this.manager.getStore();
		const active = this.manager.listActiveBindings();
		await this.refreshSecretPresence(active.map(binding => binding.secretRef));
		const computed = computeBindings({ catalog, active, hasSecret: ref => this.secretPresence.get(ref) === true, defaults: store.getCapabilityDefaults() });
		for (const [capability, list] of computed) {
			result[capability] = list;
		}
		return result;
	}

	private async refreshSecretPresence(refs: readonly string[]): Promise<void> {
		await Promise.all([...new Set(refs)].map(async ref => {
			if (!this.secretPresence.has(ref)) {
				this.secretPresence.set(ref, await this.manager.hasSecret(ref));
			}
		}));
	}

	async listBindings(capability: ProviderCapability): Promise<readonly ICapabilityBinding[]> {
		return (await this.matrix())[capability];
	}

	async resolve(request: ICapabilityRequest): Promise<ICapabilityBinding> {
		const bindings = await this.listBindings(request.capability);
		return chooseBinding(request, bindings, ref => this.secretPresence.get(ref) === true, this.manager.isEnabled());
	}

	async setDefault(capability: ProviderCapability, binding: Pick<ICapabilityBinding, 'providerId' | 'modelId' | 'source' | 'sourceId'> | undefined): Promise<void> {
		await this.manager.getStore().setCapabilityDefault(capability, binding ? { providerId: binding.providerId, modelId: binding.modelId, source: binding.source, sourceId: binding.sourceId } : undefined);
		this.changeEmitter.fire();
	}

	get configurationHidden(): boolean {
		return this.manager.isConfigurationHidden();
	}

	registerExternalProvider(provider: IExternalProvider): vscode.Disposable {
		return this.manager.registerExternalProvider(provider);
	}

	async guide(capability: ProviderCapability, caller: string): Promise<void> {
		const labels: Record<ProviderCapability, string> = {
			text: vscode.l10n.t('text generation'),
			imageUnderstanding: vscode.l10n.t('image understanding'),
			asr: vscode.l10n.t('speech recognition'),
			tts: vscode.l10n.t('speech synthesis'),
			realtimeVoice: vscode.l10n.t('realtime voice'),
		};
		if (this.manager.isConfigurationHidden()) {
			await vscode.window.showWarningMessage(vscode.l10n.t('{0} needs {1}, but the server model list is unavailable. Sign in again or retry later.', caller, labels[capability]));
			return;
		}
		const configure = vscode.l10n.t('Configure provider…');
		const learn = vscode.l10n.t('Which providers support this?');
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t('{0} needs a provider for {1}, but none is configured or enabled.', caller, labels[capability]),
			configure,
			learn,
		);
		if (choice === configure) {
			await this.manager.open({ capability });
		} else if (choice === learn) {
			const catalog = this.manager.getCatalog();
			const names = catalog?.providers.filter(provider => (capability === 'text' || capability === 'imageUnderstanding' ? provider.service === 'llm' : capability === 'realtimeVoice' ? provider.service === 'realtime' : provider.service === capability)).map(provider => provider.name) ?? [];
			await vscode.window.showInformationMessage(names.length ? vscode.l10n.t('Providers that declare {0}: {1}', labels[capability], names.join(', ')) : vscode.l10n.t('No catalog provider declares {0}. Add a custom provider.', labels[capability]));
		}
	}

	async *text(binding: ICapabilityBinding, options: ITextGenerateOptions, token: vscode.CancellationToken): AsyncIterable<vscode.LanguageModelResponsePart> {
		const secret = await this.secretFor(binding);
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		const queue: vscode.LanguageModelResponsePart[] = [];
		let notify: (() => void) | undefined;
		let done = false;
		let failure: unknown;
		const run = requestText({ modelId: binding.modelId, baseUrl: binding.baseUrl, protocol: binding.protocol, outputWindow: typeof binding.features.outputWindow === 'number' ? binding.features.outputWindow : undefined }, secret, options.messages, { tools: options.tools }, part => {
			queue.push(part);
			notify?.();
		}, controller.signal).then(() => { done = true; }, error => { failure = error; done = true; }).finally(() => notify?.());
		try {
			while (!done || queue.length) {
				if (!queue.length) {
					await new Promise<void>(resolve => { notify = resolve; });
					notify = undefined;
					continue;
				}
				yield queue.shift()!;
			}
			await run;
			if (failure) {
				throw failure;
			}
		} finally {
			cancellation.dispose();
		}
	}

	async understandImage(binding: ICapabilityBinding, options: IImageUnderstandOptions, token: vscode.CancellationToken): Promise<string> {
		const message = vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart(options.prompt), new vscode.LanguageModelDataPart(options.image, options.mimeType)]);
		let text = '';
		for await (const part of this.text(binding, { messages: [message] }, token)) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
			}
		}
		return text;
	}

	async *transcribe(binding: ICapabilityBinding, options: IAsrOptions, token: vscode.CancellationToken): AsyncIterable<{ readonly text: string; readonly final: boolean }> {
		const secret = await this.secretFor(binding);
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const text = await transcribeAudio(binding, secret, options.audio, options.mimeType, options.language, controller.signal);
			yield { text, final: true };
		} finally {
			cancellation.dispose();
		}
	}

	async *synthesize(binding: ICapabilityBinding, options: ITtsOptions, token: vscode.CancellationToken): AsyncIterable<Uint8Array> {
		const secret = await this.secretFor(binding);
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			yield* synthesizeSpeech(binding, secret, options.text, options.voiceId, options.format, controller.signal);
		} finally {
			cancellation.dispose();
		}
	}

	async openRealtimeSession(binding: ICapabilityBinding, options: IRealtimeSessionOptions): Promise<IRealtimeVoiceSession> {
		const secret = await this.secretFor(binding);
		const asr = isMoshi(binding.protocol) ? await this.resolve({ capability: 'asr' }) : undefined;
		const asrSecret = asr ? await this.secretFor(asr) : undefined;
		const session = new RealtimeVoiceSession(binding, secret, { ...this.manager.getStore().getProvider('realtime', binding.providerId).fields, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) });
		await session.whenReady();
		return asr ? new TranscribedVoiceSession(session, (audio, signal) => transcribeAudio(asr, asrSecret, audio, 'audio/wav', options.language, signal)) : session;
	}

	async resolveRealtimeConnection(binding: ICapabilityBinding): Promise<IRealtimeConnection> {
		await this.secretFor(binding);
		if (isMoshi(binding.protocol)) {
			try { await this.resolve({ capability: 'asr' }); } catch (error) { await this.guide('asr', 'Local voice input transcription'); throw error; }
		}
		const bridge = await createRealtimeBridge(binding.modelId, binding.providerId, options => this.openRealtimeSession(binding, options));
		this.voiceBridges.add(bridge);
		void bridge.closed.then(() => this.voiceBridges.delete(bridge));
		return bridge.connection;
	}

	private async secretFor(binding: ICapabilityBinding): Promise<string | undefined> {
		if (!this.manager.isEnabled()) {
			throw new CapabilityUnavailableError(binding.capability, 'disabled', []);
		}
		const secret = await this.manager.getSecret(binding.secretRef);
		if (binding.requiresApiKey && !secret) {
			throw new CapabilityUnavailableError(binding.capability, 'missingCredential', [binding.providerId]);
		}
		return secret;
	}

	dispose(): void {
		for (const bridge of this.voiceBridges) { bridge.dispose(); }
		this.voiceBridges.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
