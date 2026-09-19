/* eslint-disable header/header */
/**
 * Fork-owned desktop workbench entry for Latent. `workbench.desktop.main.ts`
 * imports this file once; every Latent service and contribution is wired here
 * so upstream merges never have to reconcile our additions inside that file.
 */

//#region --- workbench services

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ITabDraftService } from '../common/drafts.js';
import { TabDraftService } from '../browser/drafts/tabDraftService.js';
import { IThreadService } from '../common/threads.js';
import { ThreadService } from '../browser/threads/threadService.js';
import { ISideChatOpener, SideChatOpener } from '../browser/sideChat/sideChatOpener.js';
import { IManagedRuntimeService, ManagedRuntimeService } from '../browser/runtime/managedRuntimeService.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILatentRuntimeService, LATENT_RUNTIME_CHANNEL } from '../../../../platform/latentRuntime/common/latentRuntime.js';

registerSingleton(ITabDraftService, TabDraftService, InstantiationType.Delayed);
registerSingleton(IThreadService, ThreadService, InstantiationType.Delayed);
registerSingleton(ISideChatOpener, SideChatOpener, InstantiationType.Delayed);
registerMainProcessRemoteService(ILatentRuntimeService, LATENT_RUNTIME_CHANNEL);
registerSingleton(IManagedRuntimeService, ManagedRuntimeService, InstantiationType.Delayed);

//#endregion


//#region --- workbench contributions

// Latent system-wide text selection and Selection Bar
import '../../latentSelection/electron-browser/latentSelection.contribution.js';

// Latent settings
import '../browser/latentConfiguration.js';

// Floating chat composer, one per editable tab
import { FloatingComposerStartup } from '../browser/floatingComposer/tabComposerCoordinator.js';
registerWorkbenchContribution2(FloatingComposerStartup.ID, FloatingComposerStartup, WorkbenchPhase.AfterRestored);

// Threads: branching edits, version switching, the + button
import { ThreadActionsContribution } from '../browser/threads/threadActions.js';
registerWorkbenchContribution2(ThreadActionsContribution.ID, ThreadActionsContribution, WorkbenchPhase.AfterRestored);

// The Editor Area title `+` on every editor
import '../browser/editorTitleNewChat.js';

// Sessions as a top-level search entry
import '../browser/sessionsSearch/sessionsSearchView.js';

// System-level floating window (new thread in the editor area, full-duplex voice)
import './floatingWindow/floatingWindow.contribution.js';

// Managed runtime: status, approvals, Bots view, recall indexing
import { RuntimeContribution } from '../browser/runtime/runtime.contribution.js';
registerWorkbenchContribution2(RuntimeContribution.ID, RuntimeContribution, WorkbenchPhase.Eventually);

// Managed runtime access for extensions (`latent.runtime.api.*`)
import '../browser/runtime/runtimeApiCommands.js';

// Product overrides of derivative builds: context keys and the optional workbench overlay
import { LatentProductContribution } from '../browser/latentProduct.js';
registerWorkbenchContribution2(LatentProductContribution.ID, LatentProductContribution, WorkbenchPhase.BlockRestore);

// One-time copy of Study Buddy provider credentials to the Provider extension
import { ProviderSecretMigrationContribution } from '../browser/migration/providerSecretMigration.js';
registerWorkbenchContribution2(ProviderSecretMigrationContribution.ID, ProviderSecretMigrationContribution, WorkbenchPhase.Eventually);

//#endregion
