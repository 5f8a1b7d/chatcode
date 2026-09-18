import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IComposerDraft, IComposerPlugin, IComposerSnapshot, IComposerSubmitPort, IComposerAttachment, IComposerAttachmentCapabilities, IComposerModelOptions, IComposerSubmissionState, IComposerPluginActivationContext } from './composerContracts.js';
import { ComposerSubmitKind } from './composerContracts.js';

function copyDraft(draft: IComposerDraft): IComposerDraft {
	return { text: draft.text, attachments: draft.attachments.map(attachment => ({ ...attachment })) };
}

/** Headless state and commands shared by every composer renderer. */
export class ComposerModel<TContext extends IComposerPluginActivationContext = IComposerPluginActivationContext> extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _plugins = new Map<string, IComposerPlugin<TContext>>();
	private readonly _pluginListeners = this._register(new DisposableMap<string, DisposableStore>());
	private _snapshot: IComposerSnapshot;

	// A fresh object identifies each draft revision.
	private _draftRevision = {};

	constructor(
		private _submitPort: IComposerSubmitPort,
		options: IComposerModelOptions,
	) {
		super();
		this._snapshot = {
			capabilities: { ...options.initialCapabilities },
			draft: copyDraft(options.initialDraft),
			disabled: false,
			submitting: false,
			submission: {
				requestInProgress: false,
				supportsSteering: options.supportsSteering,
				preferredPendingKind: options.preferredPendingKind,
			},
			error: undefined,
			plugins: [],
		};
	}

	/** State reducers */
	setDraft(draft: IComposerDraft): void {
		this._setDraft(draft);
	}

	setText(text: string): void {
		if (text === this._snapshot.draft.text) {
			return;
		}
		this._setDraft({
			...this._snapshot.draft,
			text,
		});
	}

	addAttachment(attachment: IComposerAttachment): void {
		this._setDraft({
			...this._snapshot.draft,
			attachments: [...this._snapshot.draft.attachments, attachment],
		});
	}

	removeAttachment(id: string): void {
		const newAttachments = this._snapshot.draft.attachments.filter(attachment => attachment.id !== id);
		if (newAttachments.length === this._snapshot.draft.attachments.length) {
			return;
		}
		this._setDraft({
			...this._snapshot.draft,
			attachments: newAttachments,
		});
	}

	private _setDraft(draft: IComposerDraft): void {
		this._draftRevision = {};
		this._update({ draft: copyDraft(draft), error: undefined });
	}

	getSnapshot = (): IComposerSnapshot => this._snapshot;

	setSubmissionState(submission: Partial<IComposerSubmissionState>): void {
		const next = { ...this._snapshot.submission, ...submission };
		const current = this._snapshot.submission;
		if (next.requestInProgress !== current.requestInProgress || next.supportsSteering !== current.supportsSteering || next.preferredPendingKind !== current.preferredPendingKind) {
			this._update({ submission: next });
		}
	}

	setDisabled(disabled: boolean): void {
		if (disabled !== this._snapshot.disabled) {
			this._update({ disabled });
		}
	}

	setSubmitPort(port: IComposerSubmitPort): void {
		if (this._submitPort !== port) {
			this._submitPort = port;
			this._draftRevision = {};
		}
	}

	setCapabilities(capabilities: IComposerAttachmentCapabilities): void {
		if (capabilities.supportsFileAttachments !== this._snapshot.capabilities.supportsFileAttachments || capabilities.supportsImageAttachments !== this._snapshot.capabilities.supportsImageAttachments) {
			this._update({ capabilities: { ...capabilities } });
		}
	}

	/** Plugins */
	registerPlugin(plugin: IComposerPlugin<TContext>): IDisposable {
		if (this._store.isDisposed) {
			return Disposable.None;
		}
		this._pluginListeners.deleteAndDispose(plugin.id);
		this._plugins.set(plugin.id, plugin);

		const listeners = new DisposableStore();
		this._pluginListeners.set(plugin.id, listeners);
		if (plugin.onDidChange) {
			listeners.add(plugin.onDidChange(() => this._publishPlugins()));
		}
		this._publishPlugins();

		return toDisposable(() => {
			if (this._pluginListeners.get(plugin.id) === listeners) {
				this.unregisterPlugin(plugin.id);
			}
		});
	}

	async activatePlugin(id: string, context?: TContext): Promise<void> {
		const plugin = this._plugins.get(id);
		const listeners = this._pluginListeners.get(id);
		if (!plugin || this._snapshot.disabled || this._store.isDisposed) {
			return;
		}
		try {
			if (plugin.getState().disabled) {
				return;
			}
			this._update({ error: undefined });
			await plugin.activate(context);
			if (this._pluginListeners.get(id) === listeners && !this._store.isDisposed) {
				this._publishPlugins();
			}
		} catch (error) {
			if (this._pluginListeners.get(id) === listeners) {
				this._update({ error: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	private unregisterPlugin(id: string): void {
		if (!this._plugins.delete(id)) {
			return;
		}
		this._pluginListeners.deleteAndDispose(id);
		this._publishPlugins();
	}

	private _publishPlugins(): void {
		const plugins = Array.from(this._plugins.values(), plugin => ({
			id: plugin.id,
			placement: plugin.placement,
			order: plugin.order,
			state: { ...plugin.getState() },
		})).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
		this._update({ plugins });
	}

	/** Submit */
	private _resolveSubmitKind(): ComposerSubmitKind {
		const submission = this._snapshot.submission;
		if (!submission.requestInProgress) {
			return ComposerSubmitKind.Send;
		}

		const preferredKind = submission.preferredPendingKind;
		if (preferredKind === ComposerSubmitKind.Steering && !submission.supportsSteering) {
			return ComposerSubmitKind.Queued;
		}
		return preferredKind;
	}

	canSubmit(): boolean {
		return !this._store.isDisposed &&
			!this._snapshot.disabled &&
			!this._snapshot.submitting &&
			(
				this._snapshot.draft.text.trim() !== '' ||
				this._snapshot.draft.attachments.length > 0
			);
	}

	async submit(): Promise<boolean> {
		if (!this.canSubmit()) {
			return false;
		}

		const draft = this._snapshot.draft;
		const submittedRevision = this._draftRevision;
		const kind = this._resolveSubmitKind();
		const submitPort = this._submitPort;

		this._update({ submitting: true, error: undefined });

		try {
			await submitPort.submit(draft, kind);

			// Preserve edits made while the submission was being accepted.
			this._update({
				draft: this._draftRevision === submittedRevision ? { text: '', attachments: [] } : this._snapshot.draft,
				submitting: false,
			});
			return true;
		} catch (error) {
			this._update({
				submitting: false,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/** Lifecycle */
	private _update(update: Partial<IComposerSnapshot>): void {
		if (this._store.isDisposed) {
			return;
		}
		this._snapshot = { ...this._snapshot, ...update };
		this._onDidChange.fire();
	}

	override dispose(): void {
		this._plugins.clear();
		super.dispose();
	}
}
