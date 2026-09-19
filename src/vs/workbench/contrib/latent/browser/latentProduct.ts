/* eslint-disable header/header */
import { FileAccess } from '../../../../base/common/network.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

/**
 * Product overrides of a derivative build (`product.json` key `latentPrivate`).
 * The public build never sets them; a derivative build may.
 */
export interface ILatentDerivativeProductConfiguration {
	/** Hides local model configuration (Provider Manager, custom providers, credentials, token plans). */
	readonly hideProviderConfiguration?: boolean;
	/** Base URL of the derivative's server; consumed by the derivative's own extensions. */
	readonly serverUrl?: string;
	readonly [key: string]: unknown;
}

function derivativeConfiguration(productService: IProductService): ILatentDerivativeProductConfiguration | undefined {
	const value = (productService as IProductService & { readonly latentPrivate?: unknown }).latentPrivate;
	return typeof value === 'object' && value !== null ? value as ILatentDerivativeProductConfiguration : undefined;
}

export const LatentDerivativeBuildContext = new RawContextKey<boolean>('latent.derivativeBuild', false, localize('latent.derivativeBuild', "Whether this is a derivative build with product overrides."));
export const LatentProviderConfigurationHiddenContext = new RawContextKey<boolean>('latent.providerConfigurationHidden', false, localize('latent.providerConfigurationHidden', "Whether local model configuration is hidden by the product."));

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
		const configuration = derivativeConfiguration(productService);
		LatentDerivativeBuildContext.bindTo(contextKeyService).set(!!configuration);
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

CommandsRegistry.registerCommand('latent.product.derivativeConfiguration', (accessor: ServicesAccessor) => derivativeConfiguration(accessor.get(IProductService)));
