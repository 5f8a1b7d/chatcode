/* eslint-disable header/header */
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IExtensionStorageService } from '../../../../../platform/extensionManagement/common/extensionStorage.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';

/** Extension identifiers involved in the split (spec 02 §6.3). */
export const legacyStudyBuddyExtensionId = 'latentnote.latentnote-study-buddy';
export const providerExtensionId = 'latentnote.latent-provider';

const markerKey = 'latent.provider.secretMigration.v1';
const legacyStateKey = 'customProviders.state.v1';
const secretPrefix = 'customProviders.secret.v1.';

interface ILegacyProviderState {
	version: 1;
	providers?: Record<string, { enabled?: boolean }>;
	plans?: Record<string, boolean>;
	customProviders?: { id: string; service: string; secretFields?: { id: string }[] }[];
}

/** Secret storage keys are scoped by extension identifier; this mirrors `MainThreadSecretState.getKey`. */
export function secretStorageKey(extensionId: string, key: string): string {
	return JSON.stringify({ extensionId, key });
}

/** Secret refs the legacy state implies: providers, their extra slots, and token plans. */
export function legacySecretRefs(state: ILegacyProviderState, knownSecretSlots: Record<string, readonly string[]> = {}): string[] {
	const refs = new Set<string>();
	for (const key of Object.keys(state.providers ?? {})) {
		refs.add(key);
		for (const slot of knownSecretSlots[key] ?? []) {
			refs.add(`${key}.${slot}`);
		}
	}
	for (const provider of state.customProviders ?? []) {
		const key = `${provider.service}:${provider.id}`;
		refs.add(key);
		for (const field of provider.secretFields ?? []) {
			refs.add(`${key}.${field.id}`);
		}
	}
	for (const plan of Object.keys(state.plans ?? {})) {
		refs.add(`plan:${plan}`);
	}
	return [...refs];
}

/**
 * Copies the Study Buddy extension's provider state and credentials to the
 * Provider extension once per profile. Extensions cannot read each other's
 * secrets, so the workbench performs the copy (P2-AS-014).
 */
export class ProviderSecretMigrationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.latentProviderSecretMigration';

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IExtensionStorageService private readonly extensionStorageService: IExtensionStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		void this.run();
	}

	private async run(): Promise<void> {
		if (this.storageService.get(markerKey, StorageScope.PROFILE) === 'done') {
			return;
		}
		try {
			const copied = await this.migrate();
			this.storageService.store(markerKey, 'done', StorageScope.PROFILE, StorageTarget.MACHINE);
			if (copied > 0) {
				this.logService.info(`[LatentProviderMigration] Copied ${copied} provider credential(s) to ${providerExtensionId}.`);
			}
		} catch (error) {
			this.logService.error('[LatentProviderMigration] Migration failed; it will be retried on the next start.', error);
		}
	}

	private async migrate(): Promise<number> {
		const legacyState = this.extensionStorageService.getExtensionState(legacyStudyBuddyExtensionId, true);
		const blob = legacyState?.[legacyStateKey] as ILegacyProviderState | undefined;
		if (!blob || blob.version !== 1) {
			return 0;
		}
		// Hand the state blob to the new extension; it imports and clears it on activation.
		const providerState = this.extensionStorageService.getExtensionState(providerExtensionId, true) ?? {};
		if (!providerState[legacyStateKey] && !providerState['latent.provider.state.v2']) {
			this.extensionStorageService.setExtensionState(providerExtensionId, { ...providerState, [legacyStateKey]: blob }, true);
		}
		let copied = 0;
		for (const ref of legacySecretRefs(blob)) {
			const key = secretPrefix + ref;
			const value = await this.secretStorageService.get(secretStorageKey(legacyStudyBuddyExtensionId, key));
			if (value === undefined) {
				continue;
			}
			const targetKey = secretStorageKey(providerExtensionId, key);
			if (await this.secretStorageService.get(targetKey) === undefined) {
				await this.secretStorageService.set(targetKey, value);
				copied++;
			}
		}
		return copied;
	}
}
