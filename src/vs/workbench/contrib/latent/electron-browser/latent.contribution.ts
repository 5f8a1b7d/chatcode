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

registerSingleton(ITabDraftService, TabDraftService, InstantiationType.Delayed);
registerSingleton(IThreadService, ThreadService, InstantiationType.Delayed);
registerSingleton(ISideChatOpener, SideChatOpener, InstantiationType.Delayed);

//#endregion


//#region --- workbench contributions

// StudyBuddy system-wide text selection
import '../../studyBuddySelection/electron-browser/studyBuddySelection.contribution.js';

// Latent settings
import '../browser/latentConfiguration.js';

// Floating chat composer, one per editable tab
import { FloatingComposerStartup } from '../browser/floatingComposer/tabComposerCoordinator.js';
registerWorkbenchContribution2(FloatingComposerStartup.ID, FloatingComposerStartup, WorkbenchPhase.AfterRestored);

// Threads: branching edits, version switching, the + button
import { ThreadActionsContribution } from '../browser/threads/threadActions.js';
registerWorkbenchContribution2(ThreadActionsContribution.ID, ThreadActionsContribution, WorkbenchPhase.AfterRestored);

// Sessions as a top-level search entry
import '../browser/sessionsSearch/sessionsSearchView.js';

//#endregion
