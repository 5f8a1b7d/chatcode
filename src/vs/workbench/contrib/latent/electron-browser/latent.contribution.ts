/* eslint-disable header/header */
/**
 * Fork-owned desktop workbench entry for Latent. `workbench.desktop.main.ts`
 * imports this file once; every Latent service and contribution is wired here
 * so upstream merges never have to reconcile our additions inside that file.
 */

//#region --- workbench services



//#endregion


//#region --- workbench contributions

// StudyBuddy system-wide text selection
import '../../studyBuddySelection/electron-browser/studyBuddySelection.contribution.js';

// Floating chat composer
import '../browser/floatingComposer/floatingComposerHost.js';

//#endregion
