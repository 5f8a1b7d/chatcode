# Latent fork notes

This repository is a fork of [microsoft/vscode](https://github.com/microsoft/vscode).
Fork features live in fork-owned files and reach upstream code through as few
seams as possible, so that merging upstream stays cheap.

## Rules

1. New behaviour goes in new files under a fork-specific folder name
   (`studyspace`, `studyBuddySelection`, `studyBuddySession`, `extensions/studybuddy`).
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

| File | Why |
| --- | --- |
| `src/vs/code/electron-main/app.ts` | Two calls into `latent.contribution.ts` (main-process services and IPC channels). |
| `src/vs/workbench/workbench.desktop.main.ts` | One import of `contrib/latent/electron-browser/latent.contribution.ts`. |
| `src/vs/workbench/api/common/extHostChatAgents2.ts` | Inserted fallback to a participant-provided language model when no default model exists. |
| `src/vs/platform/extensions/common/extensions.ts` | Added the optional `languageModelChatProviders` contribution field read by that fallback. |
| `src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts` | Composer plugin hooks used by the compact and floating composers. |
| `src/vs/workbench/contrib/chat/browser/widget/input/compactComposer.ts`, `src/vs/workbench/contrib/chat/common/composer/*` | Fork-owned composer model and compact renderer; they live in upstream folders because `chatInputPart.ts` depends on them. |
| `build/gulpfile.extensions.ts`, `build/npm/dirs.ts` | Register `extensions/studybuddy` with the build. |
| `build/lib/i18n.resources.json` | Register fork folders for localisation. |
| `package.json`, `package-lock.json` | Add the `selection-hook` native dependency. |
| `.gitignore`, `AGENTS.md` | Fork housekeeping. |

## Fork entry points

- `src/vs/code/electron-main/latent.contribution.ts`: main-process services and channels.
- `src/vs/workbench/contrib/latent/electron-browser/latent.contribution.ts`: workbench services and contributions.
- `src/vs/workbench/contrib/latent/browser/floatingComposer`: the floating chat composer.
- `extensions/studybuddy`: the Study Buddy extension.
- `specs/`: formal specifications for the three-part AI workbench (Parts 1 and 2 are committed; Part 3 is local-only and ignored).
