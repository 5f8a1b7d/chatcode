/* eslint-disable header/header */
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../nls.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IMemoryAdapterState, IMemorySnapshot, IMemoryWriteResult } from '../../../../../platform/latentRuntime/common/runtimeProtocol.js';
import { IMemoryComparisonEntry, MemoryComparisonDecision } from '../../../../../platform/latentRuntime/common/runtimePlugin.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IManagedRuntimeService } from './managedRuntimeService.js';

const memoryReviewScheme = 'latent-memory-review';

/** Read-only documents for the two sides of a reviewed entry; the text travels in the URI query. */
export class MemoryReviewContentProvider extends Disposable implements IWorkbenchContribution, ITextModelContentProvider {
	static readonly ID = 'workbench.contrib.latentMemoryReviewContent';

	constructor(
		@ITextModelService textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super();
		this._register(textModelService.registerTextModelContentProvider(memoryReviewScheme, this));
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		return this.modelService.getModel(resource) ?? this.modelService.createModel(resource.query, this.languageService.createById('markdown'), resource);
	}
}

interface IMemoryReviewServices {
	readonly runtime: IManagedRuntimeService;
	readonly quickInput: IQuickInputService;
	readonly editorService: IEditorService;
	readonly notificationService: INotificationService;
}

interface IDecisionItem extends IQuickPickItem {
	readonly decision: MemoryComparisonDecision | 'later' | 'stop';
}

/** Explicitly select the owning Bot before opening files or reviewing a staged mutation. */
export async function reviewBotMemory({ runtime, quickInput, editorService, notificationService }: IMemoryReviewServices, botId?: string): Promise<void> {
	const bots = await runtime.listBots();
	const bot = bots.find(bot => bot.id === botId) ?? (await quickInput.pick(bots.map(bot => ({ label: bot.name, bot })), { placeHolder: localize('latent.memoryReview.bot', "Choose a Bot's local memory profile") }))?.bot;
	if (!bot) { return; }
	const snapshot = await runtime.profileMemory({ botId: bot.id, action: 'snapshot' }) as IMemorySnapshot & { profileHome: string };
	const items = [
		...['memories/MEMORY.md', 'memories/USER.md', 'SOUL.md', 'config.yaml'].map(file => ({ label: file, file, pendingId: undefined as string | undefined })),
		...snapshot.staged.map(pending => ({ label: localize('latent.memoryReview.pending', "Review: {0}", pending.summary), file: undefined as string | undefined, pendingId: pending.id })),
	];
	const picked = await quickInput.pick(items, { title: bot.name, placeHolder: localize('latent.memoryReview.localFiles', "Changes to SOUL and memory enter existing chats after successful compression") });
	if (picked?.file) { await editorService.openEditor({ resource: URI.joinPath(URI.file(snapshot.profileHome), picked.file) }); }
	else if (picked?.pendingId) {
		const decision = await quickInput.pick([{ label: localize('latent.memoryReview.apply', "Apply Change"), accept: true }, { label: localize('latent.memoryReview.discard', "Discard Change"), accept: false }], { title: picked.label });
		if (decision) {
			const result = await runtime.profileMemory({ botId: bot.id, action: 'confirm', id: picked.pendingId, accept: decision.accept }) as IMemoryWriteResult;
			if (decision.accept && !result.applied) { notificationService.warn(result.message ?? localize('latent.memoryReview.notApplied', "Memory changed before approval; read it again and retry.")); }
		}
	}
}

/**
 * Walks the entries where local memory and an adapter's copy differ (P1-FR-095).
 * Nothing changes unless the user decides an entry: a conflict is shown as a diff,
 * and each decision is applied on its own.
 */
export async function reviewMemoryAdapter({ runtime, quickInput, editorService, notificationService }: IMemoryReviewServices, adapterId?: string): Promise<void> {
	const adapters = (await runtime.listMemoryAdapters()).filter(adapter => adapter.enabled);
	let adapter: IMemoryAdapterState | undefined = adapters.find(candidate => candidate.id === adapterId);
	if (!adapter) {
		if (!adapters.length) {
			notificationService.info(localize('latent.memoryReview.noAdapter', "Enable a memory adapter to review its copy."));
			return;
		}
		const picked = adapters.length === 1 ? adapters[0] : (await quickInput.pick(adapters.map(candidate => ({ label: candidate.displayName, adapter: candidate })), { placeHolder: localize('latent.memoryReview.pickAdapter', "Memory adapter to compare with local memory") }))?.adapter;
		if (!picked) {
			return;
		}
		adapter = picked;
	}
	const differing = (await runtime.compareMemoryAdapter(adapter.id)).filter(entry => entry.status !== 'same');
	if (!differing.length) {
		notificationService.info(localize('latent.memoryReview.match', "Local memory and {0} match.", adapter.displayName));
		return;
	}
	let settled = 0;
	for (const [index, entry] of differing.entries()) {
		const title = localize('latent.memoryReview.title', "Memory entry {0} of {1} ({2})", index + 1, differing.length, entry.target);
		if (entry.status === 'conflict') {
			await editorService.openEditor({
				original: { resource: URI.from({ scheme: memoryReviewScheme, path: `/${entry.key}/local.md`, query: entry.local ?? '' }) },
				modified: { resource: URI.from({ scheme: memoryReviewScheme, path: `/${entry.key}/${adapter.id}.md`, query: entry.remote ?? '' }) },
				label: localize('latent.memoryReview.diff', "{0}: Local ↔ {1}", title, adapter.displayName),
				options: { preserveFocus: true },
			});
		}
		const picked = await quickInput.pick(decisionItems(entry, adapter.displayName), { title, placeHolder: placeholder(entry, adapter.displayName), ignoreFocusLost: true });
		if (!picked || picked.decision === 'stop') {
			break;
		}
		if (picked.decision !== 'later') {
			await runtime.resolveMemoryComparison(adapter.id, entry, picked.decision);
			settled++;
		}
	}
	if (settled) {
		notificationService.info(localize('latent.memoryReview.settled', "{0} of {1} differing entries settled with {2}.", settled, differing.length, adapter.displayName));
	}
}

function decisionItems(entry: IMemoryComparisonEntry, adapterName: string): IDecisionItem[] {
	const items: IDecisionItem[] = [];
	if (entry.status === 'conflict') {
		items.push(
			{ decision: 'keepLocal', label: localize('latent.memoryReview.keepLocal', "Keep Local"), detail: localize('latent.memoryReview.keepLocalDetail', "The copy in {0} is replaced with the local version.", adapterName) },
			{ decision: 'takeRemote', label: localize('latent.memoryReview.takeRemote', "Take Version from {0}", adapterName), detail: entry.remote },
		);
	} else if (entry.status === 'remoteOnly') {
		items.push(
			{ decision: 'takeRemote', label: localize('latent.memoryReview.addLocal', "Add to Local Memory"), detail: entry.remote },
			{ decision: 'keepLocal', label: localize('latent.memoryReview.removeRemote', "Remove from {0}", adapterName) },
		);
	} else {
		items.push({ decision: 'keepLocal', label: localize('latent.memoryReview.copyRemote', "Copy to {0}", adapterName), detail: entry.local });
	}
	items.push(
		{ decision: 'later', label: localize('latent.memoryReview.later', "Decide Later") },
		{ decision: 'stop', label: localize('latent.memoryReview.stop', "Stop Reviewing") },
	);
	return items;
}

function placeholder(entry: IMemoryComparisonEntry, adapterName: string): string {
	switch (entry.status) {
		case 'conflict': return localize('latent.memoryReview.conflict', "{0} holds a different version of this entry.", adapterName);
		case 'remoteOnly': return localize('latent.memoryReview.remoteOnly', "Only {0} has this entry.", adapterName);
		default: return localize('latent.memoryReview.localOnly', "Only local memory has this entry.");
	}
}
