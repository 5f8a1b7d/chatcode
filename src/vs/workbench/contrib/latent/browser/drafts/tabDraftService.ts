/* eslint-disable header/header */
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { revive } from '../../../../../base/common/marshalling.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IChatRequestVariableEntry } from '../../../chat/common/attachments/chatVariableEntries.js';
import { IDraft, IDraftAttachment, IPreparedDraft, IReferenceDiagnostic, ITabDraftService, renumberReference, rewriteReferencesForModel, stripReference, validateDraftReferences } from '../../common/drafts.js';
import { ITabKey, tabKeyHash, tabKeyToJSON, tabKeyFromJSON, tabKeyEquals } from '../../common/tabKey.js';

const storageKeyPrefix = 'latent.draft.';
const retentionSetting = 'latent.drafts.retentionDays';
const defaultRetentionDays = 7;

interface ISerializedDraft {
	readonly tabKey: { groupId: number; typeId: string; resource: string };
	readonly text: string;
	readonly attachments: readonly { number: number; entry: unknown; addedAt: number; removedAt?: number }[];
	readonly nextAttachmentNumber: number;
	readonly updatedAt: number;
}

class MutableDraft implements IDraft {
	constructor(
		public tabKey: ITabKey,
		public text = '',
		public attachments: IDraftAttachment[] = [],
		public nextAttachmentNumber = 1,
		public updatedAt = Date.now(),
	) { }
}

/**
 * Owns one Draft per editable Tab (P1-FR-010, P1-FR-020..024) and the
 * attachment numbering rules (P1-FR-050..055).
 */
export class TabDraftService extends Disposable implements ITabDraftService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeDraft = this._register(new Emitter<ITabKey>());
	readonly onDidChangeDraft: Event<ITabKey> = this._onDidChangeDraft.event;

	private readonly drafts = new Map<string, MutableDraft>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.pruneExpired();
	}

	getDraft(tabKey: ITabKey): IDraft {
		return this.load(tabKey);
	}

	setText(tabKey: ITabKey, text: string): void {
		const draft = this.load(tabKey);
		if (draft.text === text) {
			return;
		}
		draft.text = text;
		this.save(draft);
	}

	addAttachment(tabKey: ITabKey, entry: IChatRequestVariableEntry): number {
		const draft = this.load(tabKey);
		const number = draft.nextAttachmentNumber++;
		draft.attachments.push({ number, entry, addedAt: Date.now() });
		this.save(draft);
		return number;
	}

	removeAttachment(tabKey: ITabKey, number: number): void {
		const draft = this.load(tabKey);
		const index = draft.attachments.findIndex(attachment => attachment.number === number && attachment.removedAt === undefined);
		if (index < 0) {
			return;
		}
		draft.attachments[index] = { ...draft.attachments[index], removedAt: Date.now() };
		this.save(draft);
	}

	reAddAttachment(tabKey: ITabKey, number: number): number | undefined {
		const draft = this.load(tabKey);
		const removed = draft.attachments.find(attachment => attachment.number === number && attachment.removedAt !== undefined);
		if (!removed) {
			return undefined;
		}
		const next = draft.nextAttachmentNumber++;
		draft.attachments.push({ number: next, entry: removed.entry, addedAt: Date.now() });
		draft.text = renumberReference(draft.text, number, next);
		this.save(draft);
		return next;
	}

	removeReference(tabKey: ITabKey, number: number): void {
		const draft = this.load(tabKey);
		const text = stripReference(draft.text, number);
		if (text !== draft.text) {
			draft.text = text;
			this.save(draft);
		}
	}

	validateReferences(tabKey: ITabKey): readonly IReferenceDiagnostic[] {
		const draft = this.load(tabKey);
		return validateDraftReferences(draft.text, draft.attachments, draft.nextAttachmentNumber);
	}

	prepareForSend(tabKey: ITabKey): IPreparedDraft {
		const draft = this.load(tabKey);
		const diagnostics = this.validateReferences(tabKey);
		if (diagnostics.length) {
			throw new DraftReferenceError(diagnostics);
		}
		const attachments = draft.attachments.filter(attachment => attachment.removedAt === undefined).sort((a, b) => a.number - b.number);
		return { text: rewriteReferencesForModel(draft.text, attachments), displayText: draft.text, attachments };
	}

	clearAfterSend(tabKey: ITabKey): void {
		const draft = this.load(tabKey);
		draft.text = '';
		draft.attachments = [];
		this.save(draft);
	}

	rekey(from: ITabKey, to: ITabKey): void {
		if (tabKeyEquals(from, to)) {
			return;
		}
		const draft = this.load(from);
		this.drafts.delete(tabKeyHash(from));
		this.storageService.remove(storageKeyPrefix + tabKeyHash(from), StorageScope.WORKSPACE);
		draft.tabKey = to;
		this.drafts.set(tabKeyHash(to), draft);
		this.save(draft);
		this._onDidChangeDraft.fire(from);
	}

	private load(tabKey: ITabKey): MutableDraft {
		const key = tabKeyHash(tabKey);
		let draft = this.drafts.get(key);
		if (draft) {
			return draft;
		}
		const raw = this.storageService.get(storageKeyPrefix + key, StorageScope.WORKSPACE);
		if (raw) {
			try {
				const parsed: ISerializedDraft = JSON.parse(raw);
				draft = new MutableDraft(
					tabKeyFromJSON(parsed.tabKey),
					parsed.text,
					parsed.attachments.map(attachment => ({ ...attachment, entry: revive<IChatRequestVariableEntry>(attachment.entry) })),
					parsed.nextAttachmentNumber,
					parsed.updatedAt,
				);
			} catch {
				// Corrupt drafts are set aside for recovery instead of blocking the composer.
				this.storageService.store(storageKeyPrefix + key + '.corrupt', raw, StorageScope.WORKSPACE, StorageTarget.MACHINE);
				this.storageService.remove(storageKeyPrefix + key, StorageScope.WORKSPACE);
			}
		}
		draft ??= new MutableDraft(tabKey);
		this.drafts.set(key, draft);
		return draft;
	}

	private save(draft: MutableDraft): void {
		draft.updatedAt = Date.now();
		const serialized: ISerializedDraft = {
			tabKey: tabKeyToJSON(draft.tabKey),
			text: draft.text,
			attachments: draft.attachments,
			nextAttachmentNumber: draft.nextAttachmentNumber,
			updatedAt: draft.updatedAt,
		};
		this.storageService.store(storageKeyPrefix + tabKeyHash(draft.tabKey), JSON.stringify(serialized), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChangeDraft.fire(draft.tabKey);
	}

	private pruneExpired(): void {
		const days = this.configurationService.getValue<number>(retentionSetting) ?? defaultRetentionDays;
		const cutoff = Date.now() - Math.max(0, days) * 24 * 60 * 60 * 1000;
		for (const key of this.storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE)) {
			if (!key.startsWith(storageKeyPrefix) || key.endsWith('.corrupt')) {
				continue;
			}
			try {
				const parsed: ISerializedDraft = JSON.parse(this.storageService.get(key, StorageScope.WORKSPACE, '{}'));
				if (typeof parsed.updatedAt === 'number' && parsed.updatedAt < cutoff) {
					this.storageService.remove(key, StorageScope.WORKSPACE);
				}
			} catch {
				this.storageService.remove(key, StorageScope.WORKSPACE);
			}
		}
	}
}

export class DraftReferenceError extends Error {
	constructor(readonly diagnostics: readonly IReferenceDiagnostic[]) {
		super(diagnostics.map(diagnostic => `#${diagnostic.number} (${diagnostic.kind})`).join(', '));
		this.name = 'DraftReferenceError';
	}
}
