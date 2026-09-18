import type * as vscode from 'vscode';

export type ProviderCapability = 'text' | 'imageUnderstanding' | 'asr' | 'tts' | 'realtimeVoice';

export const providerCapabilities: readonly ProviderCapability[] = ['text', 'imageUnderstanding', 'asr', 'tts', 'realtimeVoice'];

export interface ICapabilityRequirements {
	readonly streaming?: boolean;
	readonly tools?: boolean;
	readonly languages?: readonly string[];
	readonly duplex?: boolean;
}

export interface ICapabilityRequest {
	readonly capability: ProviderCapability;
	readonly requires?: ICapabilityRequirements;
	readonly preferredProviderId?: string;
	readonly preferredModelId?: string;
}

export interface ICapabilityBinding {
	readonly capability: ProviderCapability;
	readonly providerId: string;
	readonly providerName: string;
	readonly modelId: string;
	readonly modelName: string;
	readonly protocol: string;
	readonly baseUrl: string;
	readonly secretRef: string;
	readonly requiresApiKey: boolean;
	readonly features: Readonly<Record<string, boolean | readonly string[] | number>>;
	readonly isDefault: boolean;
	readonly source: 'direct' | 'plan';
	readonly sourceId: string;
}

export type CapabilityUnavailableReason = 'noProvider' | 'disabled' | 'missingCredential' | 'unsupportedRequirement';

/** Raised by `resolve` when no usable binding exists (P2-FR-053). */
export class CapabilityUnavailableError extends Error {
	constructor(
		readonly capability: ProviderCapability,
		readonly reason: CapabilityUnavailableReason,
		readonly candidates: readonly string[],
	) {
		super(`No provider is available for ${capability} (${reason}).`);
		this.name = 'CapabilityUnavailableError';
	}
}

export interface ITextGenerateOptions {
	readonly messages: readonly vscode.LanguageModelChatRequestMessage[];
	readonly tools?: readonly vscode.LanguageModelChatTool[];
}

export interface IImageUnderstandOptions {
	readonly image: Uint8Array;
	readonly mimeType: string;
	readonly prompt: string;
}

export interface IAsrOptions {
	readonly audio: Uint8Array;
	readonly mimeType: string;
	readonly language?: string;
}

export interface ITtsOptions {
	readonly text: string;
	readonly voiceId?: string;
	readonly language?: string;
	readonly format?: 'pcm16' | 'mp3' | 'ogg' | 'wav';
}

export interface IRealtimeSessionOptions {
	readonly language?: string;
	readonly voiceId?: string;
	readonly instructions?: string;
}

export interface IRealtimeTranscript {
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly final: boolean;
}

export interface IRealtimeVoiceSession extends vscode.Disposable {
	/** PCM16 mono audio at 24 kHz. */
	sendAudio(chunk: Uint8Array): void;
	commitAudio(): void;
	readonly onAudio: vscode.Event<Uint8Array>;
	readonly onTranscript: vscode.Event<IRealtimeTranscript>;
	readonly onDidClose: vscode.Event<{ readonly reason: string }>;
	interrupt(): void;
}

/** Connection details a trusted renderer can use to open the realtime session itself. */
export interface IRealtimeConnection {
	readonly url: string;
	readonly protocols: readonly string[];
	readonly model: string;
	readonly providerId: string;
}

export interface ILatentProviderApi {
	readonly version: 1;
	readonly onDidChangeBindings: vscode.Event<void>;
	resolve(request: ICapabilityRequest): Promise<ICapabilityBinding>;
	listBindings(capability: ProviderCapability): Promise<readonly ICapabilityBinding[]>;
	setDefault(capability: ProviderCapability, binding: Pick<ICapabilityBinding, 'providerId' | 'modelId' | 'source' | 'sourceId'> | undefined): Promise<void>;
	/** Opens the guidance flow of P2-FR-053 for a capability. */
	guide(capability: ProviderCapability, caller: string): Promise<void>;
	text(binding: ICapabilityBinding, options: ITextGenerateOptions, token: vscode.CancellationToken): AsyncIterable<vscode.LanguageModelResponsePart>;
	understandImage(binding: ICapabilityBinding, options: IImageUnderstandOptions, token: vscode.CancellationToken): Promise<string>;
	transcribe(binding: ICapabilityBinding, options: IAsrOptions, token: vscode.CancellationToken): AsyncIterable<{ readonly text: string; readonly final: boolean }>;
	synthesize(binding: ICapabilityBinding, options: ITtsOptions, token: vscode.CancellationToken): AsyncIterable<Uint8Array>;
	openRealtimeSession(binding: ICapabilityBinding, options: IRealtimeSessionOptions): Promise<IRealtimeVoiceSession>;
	resolveRealtimeConnection(binding: ICapabilityBinding): Promise<IRealtimeConnection>;
}
