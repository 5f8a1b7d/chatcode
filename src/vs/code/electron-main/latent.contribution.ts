/* eslint-disable header/header */
import { Server as ElectronIPCServer } from '../../base/parts/ipc/electron-main/ipc.electron.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { IStudyBuddySelectionService, STUDY_BUDDY_SELECTION_CHANNEL } from '../../platform/studyBuddySelection/common/studyBuddySelection.js';
import { StudyBuddySelectionChannel } from '../../platform/studyBuddySelection/common/studyBuddySelectionIpc.js';
import { StudyBuddySelectionMainService } from '../../platform/studyBuddySelection/electron-main/studyBuddySelectionMainService.js';

/**
 * Fork-owned registration seam for main-process services added by Latent.
 * `app.ts` calls these two functions and nothing else, so upstream merges only
 * ever touch those single call sites.
 */
export function registerLatentMainServices(services: ServiceCollection): void {
	// StudyBuddy system-wide text selection
	services.set(IStudyBuddySelectionService, new SyncDescriptor(StudyBuddySelectionMainService, undefined, false));
}

/**
 * Registers the IPC channels for Latent main-process services once the
 * service instances are available.
 */
export function registerLatentMainChannels(accessor: ServicesAccessor, mainProcessElectronServer: ElectronIPCServer): void {
	// StudyBuddy system-wide text selection
	const studyBuddySelectionChannel = new StudyBuddySelectionChannel(accessor.get(IStudyBuddySelectionService));
	mainProcessElectronServer.registerChannel(STUDY_BUDDY_SELECTION_CHANNEL, studyBuddySelectionChannel);
}
