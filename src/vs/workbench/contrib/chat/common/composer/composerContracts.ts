/* eslint-disable header/header */
import type { Event } from '../../../../../base/common/event.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { IChatAgentAttachmentCapabilities } from '../participants/chatAgents.js';

/** Semantic icon name interpreted by composer render adapters. */
export type ComposerPluginIcon = string;

/** Semantic lane occupied by a plugin in composer renderers. */
export type ComposerPluginPlacement = 'header' | 'leading' | 'trailing';

/** Preferred density for a plugin action. */
export type ComposerPluginPresentation = 'icon' | 'iconLabel';

/** Submission behavior selected from the current request state. */
export const enum ComposerSubmitKind {
	Send = 'send',
	Queued = 'queued',
	Steering = 'steering',
}

/** Request state used to choose between sending, queueing, and steering. */
export interface IComposerSubmissionState {
	readonly requestInProgress: boolean;
	readonly supportsSteering: boolean;
	readonly preferredPendingKind: ComposerSubmitKind.Queued | ComposerSubmitKind.Steering;
}

/** External capability used by the headless composer to submit a prompt. */
export interface IComposerSubmitPort {
	/**
	 * Resolves once the request has been accepted, including entering the queue.
	 * It must not wait until a queued request actually starts running.
	 */
	submit(draft: IComposerDraft, kind: ComposerSubmitKind): Promise<void>;
}

/** Initial state and submission preferences for a composer model. */
export interface IComposerModelOptions
	extends Pick<IComposerSubmissionState, 'supportsSteering' | 'preferredPendingKind'> {
	readonly initialDraft: IComposerDraft;
	readonly initialCapabilities: IComposerAttachmentCapabilities;
}

/** File and image attachment support exposed to a composer renderer. */
export type IComposerAttachmentCapabilities = Readonly<Pick<IChatAgentAttachmentCapabilities, 'supportsFileAttachments' | 'supportsImageAttachments'>>;

/**
 * Attachment represented by a stable id. Files and images carry a resource;
 * any other chat context (selection, symbol, paste) is a `context` attachment
 * with a display label. `number` is the Latent attachment number (P1-FR-050).
 */
export type IComposerAttachment =
	{ readonly kind: 'image'; readonly resource: URI; readonly mimeType: string; readonly id: string; readonly number?: number; readonly isReadOnly?: boolean } |
	{ readonly kind: 'file'; readonly resource: URI; readonly mimeType: string; readonly id: string; readonly number?: number; readonly isReadOnly?: boolean } |
	{ readonly kind: 'context'; readonly label: string; readonly mimeType: string; readonly id: string; readonly number?: number; readonly detail?: string; readonly isReadOnly?: boolean };

/** A problem with a `#<number>` reference that blocks sending (P1-FR-053). */
export interface IComposerDiagnostic {
	readonly kind: 'invalid' | 'stale';
	readonly number: number;
	readonly message: string;
}

/** Editable prompt content owned by the composer model. */
export interface IComposerDraft {
	readonly text: string;
	readonly attachments: readonly IComposerAttachment[];
}

/** Immutable state consumed by framework-specific render adapters. */
export interface IComposerSnapshot {
	readonly capabilities: IComposerAttachmentCapabilities;
	readonly draft: IComposerDraft;
	readonly submission: IComposerSubmissionState;
	readonly disabled: boolean;
	readonly submitting: boolean;
	readonly error: string | undefined;
	readonly diagnostics: readonly IComposerDiagnostic[];
	readonly plugins: readonly IComposerPluginSnapshot[];
}

/** Render-independent state exposed by a composer plugin. */
export interface IComposerPluginState {
	readonly label: string;
	readonly icon: ComposerPluginIcon;
	readonly presentation?: ComposerPluginPresentation;
	readonly dropdown?: boolean;
	readonly disabled?: boolean;
	readonly active?: boolean;
}

/** Renderers may extend this context with platform-specific activation data, such as a DOM anchor. */
export interface IComposerPluginActivationContext {
	readonly source?: 'toolbar' | 'keyboard' | 'command';
}

/** Plugin data captured when the model publishes a snapshot. */
export interface IComposerPluginSnapshot {
	readonly id: string;
	readonly placement: ComposerPluginPlacement;
	readonly order: number;
	readonly state: IComposerPluginState;
}

/**
 * Extends a composer with one semantic action. Plugins own their dependencies and
 * lifecycle; the core only orders and activates them.
 */
export interface IComposerPlugin<TContext extends IComposerPluginActivationContext = IComposerPluginActivationContext> {
	readonly id: string;
	readonly placement: ComposerPluginPlacement;
	readonly order: number;
	readonly onDidChange?: Event<void>;
	getState(): IComposerPluginState;
	activate(context?: TContext): void | Promise<void>;
}
