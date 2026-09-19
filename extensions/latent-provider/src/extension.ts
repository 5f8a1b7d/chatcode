import * as vscode from 'vscode';
import type { ICapabilityBinding, ILatentProviderApi, ProviderCapability } from './api';
import { providerCapabilities } from './api';
import { CapabilityService } from './capabilities/service';
import { CatalogLanguageModelProvider } from './languageModel/languageModel';
import { CapabilityMatrix, LegacyCustomProvidersEnabledSetting, ProviderEnabledSetting, ProviderManager } from './manager/manager';
import { legacyStateKey } from './store/store';

const legacyStateImportedKey = 'latent.provider.legacyStateImported';
const settingsMigratedKey = 'latent.provider.settingsMigrated';

export async function activate(context: vscode.ExtensionContext): Promise<ILatentProviderApi> {
	let capabilityService: CapabilityService | undefined;
	const manager = new ProviderManager(context, async () => {
		const matrix = await capabilityService?.matrix();
		return toMatrix(matrix, manager);
	});
	capabilityService = new CapabilityService(manager);
	context.subscriptions.push(manager, capabilityService, new CatalogLanguageModelProvider(manager));

	// Derivative builds may hide local model configuration (`latentPrivate.hideProviderConfiguration`).
	const derivative = await vscode.commands.executeCommand<{ hideProviderConfiguration?: boolean } | undefined>('latent.product.derivativeConfiguration').then(value => value, () => undefined);
	manager.setConfigurationHidden(derivative?.hideProviderConfiguration === true);

	for (const command of ['latent.provider.manage', 'latentnote.manageProviders']) {
		context.subscriptions.push(vscode.commands.registerCommand(command, () => manager.open()));
	}
	context.subscriptions.push(vscode.commands.registerCommand('latent.provider.configureCapability', (capability?: string) => manager.open({ capability: isCapability(capability) ? capability : undefined })));
	context.subscriptions.push(vscode.commands.registerCommand('latent.provider.guide', (capability: string, caller?: string) => isCapability(capability) ? capabilityService!.guide(capability, caller ?? 'Latent') : undefined));
	context.subscriptions.push(vscode.commands.registerCommand('latent.provider.resolveRealtimeConnection', async (preferredProviderId?: string) => {
		const binding = await capabilityService!.resolve({ capability: 'realtimeVoice', requires: { duplex: true }, preferredProviderId });
		return capabilityService!.resolveRealtimeConnection(binding);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('latent.provider.resolve', (capability: string) => isCapability(capability) ? capabilityService!.resolve({ capability }) : undefined));
	context.subscriptions.push(vscode.commands.registerCommand('latent.provider.importLegacyState', (state: unknown) => manager.getStore().importLegacyState(state)));
	// The managed runtime keeps its own encrypted copy so bots can run while the workbench is closed (spec 01 §3.4).
	context.subscriptions.push(vscode.commands.registerCommand('latent.provider.exportModelBinding', async (capability: string, preferredProviderId?: string) => {
		if (!isCapability(capability)) {
			return undefined;
		}
		try {
			const binding = await capabilityService!.resolve({ capability, preferredProviderId });
			const secret = await manager.getSecret(binding.secretRef);
			return { providerId: binding.providerId, modelId: binding.modelId, protocol: binding.protocol, baseUrl: binding.baseUrl, apiKey: secret };
		} catch {
			return undefined;
		}
	}));

	await migrateSettings(context);
	await manager.initialize();
	await importLegacyStateOnce(context, manager);
	return capabilityService;
}

function isCapability(value: unknown): value is ProviderCapability {
	return typeof value === 'string' && (providerCapabilities as readonly string[]).includes(value);
}

function toMatrix(matrix: Record<ProviderCapability, ICapabilityBinding[]> | undefined, manager: ProviderManager): Promise<CapabilityMatrix> {
	return (async () => {
		const result: CapabilityMatrix = {};
		for (const capability of providerCapabilities) {
			const entries = matrix?.[capability] ?? [];
			result[capability] = await Promise.all(entries.map(async entry => ({
				providerId: entry.providerId,
				providerName: entry.providerName,
				modelId: entry.modelId,
				modelName: entry.modelName,
				isDefault: entry.isDefault,
				source: entry.source,
				sourceId: entry.sourceId,
				requiresApiKey: entry.requiresApiKey,
				hasSecret: await manager.hasSecret(entry.secretRef),
			})));
		}
		return result;
	})();
}

/** Copies `chat.customProviders.enabled` into `latent.provider.enabled` once (spec 02 §6.2). */
async function migrateSettings(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(settingsMigratedKey)) {
		return;
	}
	const configuration = vscode.workspace.getConfiguration();
	const legacy = configuration.inspect<boolean>(LegacyCustomProvidersEnabledSetting);
	const current = configuration.inspect<boolean>(ProviderEnabledSetting);
	if (legacy?.globalValue !== undefined && current?.globalValue === undefined) {
		await configuration.update(ProviderEnabledSetting, legacy.globalValue, vscode.ConfigurationTarget.Global);
	}
	await context.globalState.update(settingsMigratedKey, true);
}

/** Imports the v1 provider state when the Study Buddy extension left it in this extension's storage (workbench migration) or exported it. */
async function importLegacyStateOnce(context: vscode.ExtensionContext, manager: ProviderManager): Promise<void> {
	if (context.globalState.get<boolean>(legacyStateImportedKey)) {
		return;
	}
	const blob = context.globalState.get<unknown>(legacyStateKey);
	if (blob && await manager.getStore().importLegacyState(blob)) {
		await context.globalState.update(legacyStateKey, undefined);
	}
	await context.globalState.update(legacyStateImportedKey, true);
}
