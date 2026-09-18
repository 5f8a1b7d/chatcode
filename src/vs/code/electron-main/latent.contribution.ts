/* eslint-disable header/header */
import { Server as ElectronIPCServer } from '../../base/parts/ipc/electron-main/ipc.electron.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { ILatentSelectionService, LATENT_SELECTION_CHANNEL } from '../../platform/latentSelection/common/latentSelection.js';
import { LatentSelectionChannel } from '../../platform/latentSelection/common/latentSelectionIpc.js';
import { LatentSelectionMainService } from '../../platform/latentSelection/electron-main/latentSelectionMainService.js';
import { ILatentFloatingWindowService, LATENT_FLOATING_WINDOW_CHANNEL } from '../../platform/latentFloatingWindow/common/latentFloatingWindow.js';
import { LatentFloatingWindowChannel } from '../../platform/latentFloatingWindow/common/latentFloatingWindowIpc.js';
import { LatentFloatingWindowMainService } from '../../platform/latentFloatingWindow/electron-main/latentFloatingWindowMainService.js';

/**
 * Fork-owned registration seam for main-process services added by Latent.
 * `app.ts` calls these two functions and nothing else, so upstream merges only
 * ever touch those single call sites.
 */
export function registerLatentMainServices(services: ServiceCollection): void {
	// Latent system-wide text selection and Selection Bar
	services.set(ILatentSelectionService, new SyncDescriptor(LatentSelectionMainService, undefined, false));
	// Latent system-level floating window
	services.set(ILatentFloatingWindowService, new SyncDescriptor(LatentFloatingWindowMainService, undefined, false));
}

/**
 * Registers the IPC channels for Latent main-process services once the
 * service instances are available.
 */
export function registerLatentMainChannels(accessor: ServicesAccessor, mainProcessElectronServer: ElectronIPCServer): void {
	// Latent system-wide text selection and Selection Bar
	mainProcessElectronServer.registerChannel(LATENT_SELECTION_CHANNEL, new LatentSelectionChannel(accessor.get(ILatentSelectionService)));
	// Latent system-level floating window
	mainProcessElectronServer.registerChannel(LATENT_FLOATING_WINDOW_CHANNEL, new LatentFloatingWindowChannel(accessor.get(ILatentFloatingWindowService)));
}
