# Latent fork notes

This repository is a fork of [microsoft/vscode](https://github.com/microsoft/vscode).
Fork features live in fork-owned files and reach upstream code through as few
seams as possible, so that merging upstream stays cheap.

## Rules

1. New behaviour goes in new files under a fork-specific folder name
   (`latent`, `latentSelection`, `latentFloatingWindow`, `extensions/latent-*`).
2. Upstream files are touched only to register fork code, ideally with a single
   line delegating to a fork-owned entry file. Mark the line with a `Latent` comment.
3. Never delete upstream code to make room for a fork feature. Hide it through
   its own switch (a setting default, a context key, a `when` clause) instead.
4. Additions inside an upstream function must be inserted blocks that call into
   fork code. Do not restructure or reformat the surrounding lines.
5. Do not change dependency version ranges upstream owns unless the fork needs it.

## Merging upstream

```bash
git remote add upstream https://github.com/microsoft/vscode.git   # once
git fetch upstream --tags
git merge <upstream release tag>
```

Merge release tags rather than `main`. After every merge, re-verify each file in
the list below, then run `npm run valid-layers-check` and `npm run typecheck-client`.

## Upstream files touched by the fork

Fork additions inside upstream files are marked with a `Latent` comment or JSDoc prefix.
Fork files never carry the Microsoft copyright header; `build/filters.ts` excludes the
fork-named paths from the copyright check instead of disabling it.

| File | Why |
| --- | --- |
| `src/vs/code/electron-main/app.ts` | Two calls into `latent.contribution.ts` (main-process services and IPC channels). |
| `src/vs/workbench/workbench.desktop.main.ts` | One import of `contrib/latent/electron-browser/latent.contribution.ts`. |
| `src/vs/workbench/workbench.common.main.ts` | One import of `contrib/latent/browser/overlayWebview/firstPartyOverlayWebview.contribution.ts`, the overlay webview host of the LatentNote adapter extension. It is registered here rather than in `latent.contribution.ts` because it also serves the web workbench. |
| `src/vs/workbench/api/common/extHostChatAgents2.ts` | Inserted fallback to a participant-provided language model when no default model exists. |
| `src/vs/platform/extensions/common/extensions.ts` | Added the optional `languageModelChatProviders` contribution field read by that fallback. |
| `src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts` | Renderer-neutral hooks for the Floating Composer: `getToolbarActions()` / `onDidChangeToolbarActions`, an optional anchor for `openModelPicker` / `openModePicker`, the `createAttachmentNumbering` input option, and read-only attachments. The composer plugins built on them live in `contrib/latent/browser/composer/nativeComposerPlugins.ts`. |
| `src/vs/workbench/contrib/chat/browser/chat.ts`, `widget/chatWidget.ts` | View options `prepareInput` (draft validation before sending) and `createAttachmentNumbering`, and the accept options they need. |
| `src/vs/workbench/contrib/chat/browser/attachments/{chatAttachmentModel,chatWidgetPasteTarget,implicitContextAttachment,chatAttachmentWidgets}.ts`, `widget/input/editor/{chatInputCompletions,chatPasteProviders}.ts`, `common/attachments/{chatVariableEntries,chatVariables}.ts` | Attachment Numbers (P1-FR-050..056). Every call site delegates to `contrib/latent/browser/attachmentNumbering.ts` or `contrib/latent/common/attachmentNumbers.ts` and only when the input was created with `createAttachmentNumbering`; otherwise the upstream behaviour is unchanged. Only the Floating Composer opts in. `chatAttachmentWidgets.ts` also derives a hover preview for text attachments. |
| `src/vs/workbench/contrib/chat/common/requestParser/chatRequestParser.ts`, `widget/chatContentParts/chatMarkdownDecorationsRenderer.ts` | Host-supplied attachment references in the parser context, and the preview hover of a rendered numbered reference. |
| `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.ts` | Sends generic text attachments (Selection Bar context) to agent hosts. |
| `src/vs/workbench/contrib/chat/browser/widget/media/chat.css` | Attachment number badge and truncation of long model labels. |
| `src/vs/workbench/common/editor/editorInput.ts` | `registerMoveGuard`, used by the Floating Composer to keep per-group drafts from being merged. |
| `src/vs/platform/quickinput/{common,browser}/*`, `src/vs/workbench/contrib/search/browser/anythingQuickAccess.ts` | Quick pick `additionalContent` and a content-provider registry used by the Sessions search view. |
| `build/filters.ts` | Fork-named paths excluded from the copyright header check. |
| `build/gulpfile.extensions.ts`, `build/npm/dirs.ts` | Register `extensions/latent-provider` and `extensions/latent-selection` with the build. |
| `build/lib/i18n.resources.json` | Register fork folders for localisation. |
| `package.json`, `package-lock.json`, `remote/web/package.json`, `remote/web/package-lock.json` | Add `react`/`react-dom` (loaded through `contrib/latent/browser/reactRuntime.ts`, which leaves `amdX.ts` untouched) and the `selection-hook` native dependency. |
| `.gitignore`, `AGENTS.md`, `.github/copilot-instructions.md`, `.github/instructions/coding-guidelines.instructions.md`, `.vscode/mcp.json` | Fork housekeeping; `.gitignore` also keeps derivative-build sources (`/latent-private/`, `/src/vs/workbench/contrib/latentPrivate/`) out of this repository. |
| Tests under `src/vs/workbench/contrib/chat/test/`, `src/vs/workbench/test/browser/parts/editor/editorInput.test.ts` | Cover the upstream seams above; tests of fork behaviour live in `src/vs/workbench/contrib/latent/test/`. |

## Fork entry points

- `src/vs/code/electron-main/latent.contribution.ts`: main-process services and channels.
- `src/vs/workbench/contrib/latent/electron-browser/latent.contribution.ts`: workbench services and contributions.
- `src/vs/workbench/contrib/latent/browser/floatingComposer`: the per-tab floating chat composer.
  - `browser/composer`, `common/composer`: the headless composer model, its compact React renderer, and plugins mirroring the native chat input controls.
  - `browser/attachmentNumbering.ts`, `common/attachmentNumbers.ts`: the Attachment Numbers strategy and formats.
  - `browser/editorGroupMount.ts`: the only access to editor group internals (the group element and its editor content area).
  - `browser/overlayWebview`: first-party overlay webviews over an editor group for the LatentNote adapter extension (`_workbench.firstPartyOverlayWebview.*` commands).
  - `browser/reactRuntime.ts`: loads React and ReactDOM for fork-owned React surfaces, including the private overlay.
- `src/vs/workbench/contrib/latent/browser/{drafts,threads,sideChat,sessionsSearch,migration}`: drafts, thread branching, side chat, Sessions search, credential migration (spec 01/02).
- `src/vs/workbench/contrib/latentSelection`, `src/vs/platform/latentSelection`: the Selection Bar and the system-wide selection listener.
- `src/vs/platform/latentFloatingWindow`, `src/vs/workbench/contrib/latent/electron-browser/floatingWindow`: the system-level floating window and its voice session.
- `src/vs/latentRuntime`, `src/vs/platform/latentRuntime`, `src/vs/workbench/contrib/latent/browser/runtime`: the Managed Runtime process (gateways, bots, memory, capabilities, artifacts, scheduled jobs), its main-process supervisor, and the workbench Bots view.
  - Runtime plugins (`src/vs/platform/latentRuntime/common/runtimePlugin.ts`, `src/vs/latentRuntime/node/plugins`): ES modules registered by extensions that add gateway platforms, bot tools, and memory adapters.
  - `latent.runtime.api.*` commands (`browser/runtime/runtimeApiCommands.ts`): extension access to bots, sessions, approvals, gateways, memory, artifacts, and plugins.
- `src/vs/workbench/contrib/latent/browser/latentProduct.ts`: product overrides of derivative builds (`latentPrivate` in `product.json`) as context keys, and the optional derivative workbench overlay loaded from `vs/workbench/contrib/latentPrivate/`.
- `extensions/latent-provider`: provider configuration, credentials, the capability model, and providers registered by other extensions (`latentProviderCapabilities`).
- `extensions/latent-selection`: selection actions and the action extension point.
- StudySpace and the Study Buddy harness hand-off live in the private derivative's workbench overlay. The public composer can select a derivative-provided default participant through `latentPrivate.defaultComposerAgentId` without naming a research participant.
- `specs/`: public AI workbench specifications (Parts 1 and 2). Part 3 is tracked in the independent private repository; its legacy local copy here remains ignored.
