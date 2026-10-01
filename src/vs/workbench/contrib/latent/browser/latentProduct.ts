/* eslint-disable header/header */
import { FileAccess } from '../../../../base/common/network.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import product from '../../../../platform/product/common/product.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

/**
 * Product overrides of a derivative build (`product.json` key `latentPrivate`).
 * The public build never sets them; a derivative build may.
 */
export interface ILatentDerivativeProductConfiguration {
	/** Whether the derivative exposes the public product's Copilot integrations. */
	readonly copilotEnabled?: boolean;
	/** Hides local model configuration (Provider Manager, custom providers, credentials, token plans). */
	readonly hideProviderConfiguration?: boolean;
	/** Optional chat participant selected by a derivative's per-tab composer. */
	readonly defaultComposerAgentId?: string;
	/** Base URL of the derivative's server; consumed by the derivative's own extensions. */
	readonly serverUrl?: string;
	/**
	 * Default setting values of the derivative. Registered when this module loads, before any
	 * workbench part reads configuration, so they apply from the first frame (a derivative's
	 * overlay loads later and cannot).
	 */
	readonly configurationDefaults?: Readonly<Record<string, unknown>>;
	readonly [key: string]: unknown;
}

export function getLatentDerivativeConfiguration(productService: IProductService): ILatentDerivativeProductConfiguration | undefined {
	const value = (productService as IProductService & { readonly latentPrivate?: unknown }).latentPrivate;
	return typeof value === 'object' && value !== null ? value as ILatentDerivativeProductConfiguration : undefined;
}

export function isLatentCopilotEnabled(productService: IProductService): boolean {
	return getLatentDerivativeConfiguration(productService)?.copilotEnabled !== false;
}

export const LatentDerivativeBuildContext = new RawContextKey<boolean>('latent.derivativeBuild', false, localize('latent.derivativeBuild', "Whether this is a derivative build with product overrides."));
export const LatentCopilotEnabledContext = new RawContextKey<boolean>('latent.copilotEnabled', true, localize('latent.copilotEnabled', "Whether Copilot integrations are enabled in this product."));
export const LatentProviderConfigurationHiddenContext = new RawContextKey<boolean>('latent.providerConfigurationHidden', false, localize('latent.providerConfigurationHidden', "Whether local model configuration is hidden by the product."));

const derivativeConfigurationDefaults = (product as { latentPrivate?: ILatentDerivativeProductConfiguration }).latentPrivate?.configurationDefaults;
if (derivativeConfigurationDefaults && typeof derivativeConfigurationDefaults === 'object') {
	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{ overrides: { ...derivativeConfigurationDefaults } }]);
}

/** Module path of the optional workbench overlay a derivative build places next to the fork folders. */
const derivativeOverlayModule = 'vs/workbench/contrib/latentPrivate/latentPrivate.contribution.js';

/**
 * Publishes the product overrides as context keys and, in a derivative build,
 * loads that build's workbench overlay. The public build ships no overlay, so
 * nothing is loaded there.
 */
export class LatentProductContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.latentProduct';

	constructor(
		@IProductService productService: IProductService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const configuration = getLatentDerivativeConfiguration(productService);
		LatentDerivativeBuildContext.bindTo(contextKeyService).set(!!configuration);
		LatentCopilotEnabledContext.bindTo(contextKeyService).set(configuration?.copilotEnabled !== false);
		LatentProviderConfigurationHiddenContext.bindTo(contextKeyService).set(configuration?.hideProviderConfiguration === true);
		if (configuration) {
			void this.loadOverlay();
		}
	}

	private async loadOverlay(): Promise<void> {
		try {
			await import(FileAccess.asBrowserUri(derivativeOverlayModule).toString(true));
			this.logService.info('[Latent] Loaded the derivative workbench overlay.');
		} catch (error) {
			this.logService.warn('[Latent] Product overrides are set but no derivative workbench overlay could be loaded.', error);
		}
	}
}

CommandsRegistry.registerCommand('latent.product.derivativeConfiguration', (accessor: ServicesAccessor) => getLatentDerivativeConfiguration(accessor.get(IProductService)));
