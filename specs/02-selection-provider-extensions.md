# Part 2 — Open-Source Selection and Provider Extensions

**Spec ID**: LAT-2 · **Created**: 2026-09-18 · **Status**: Draft for review · **Visibility**: Public

Vocabulary is defined once in [README.md](README.md#shared-glossary). Part 2 consumes the
Thread, Draft, Side Chat, and open-location contracts of [Part 1](01-ai-interaction.md).

## 1. Scope and succession

Part 2 splits the current `extensions/studybuddy` implementation into two public extensions and
adds the system-level Floating Window.

| New extension | Identifier | Owns |
| --- | --- | --- |
| **Selection** | `latentnote.latent-selection` | system-level and editor-level Selections; the draggable, pinnable Selection Bar; the generic *More details* explanation; the Selection Action extension point and its built-in actions (Explain, Translate, Summarize, Add to Chat, Ask in Side Chat, Edit, Comment); the private *Add to Note* extension point (registration only) |
| **Provider** | `latentnote.latent-provider` | Provider configuration UI and catalog; credentials; multimodal Provider Capability declarations; model invocation for every Provider Capability; the language-model registration (`vendor: latentnote-catalog`) |

The Floating Window is fork-owned Workbench/main-process code (not an extension) because it is a
separate OS window: `src/vs/platform/latentFloatingWindow/` and
`src/vs/workbench/contrib/latent/browser/floatingWindow/`.

Succession: Part 2 succeeds the Study Buddy extension's `providers/*`, `editor/selection.ts`,
`learning/explanationController.ts` (selection actions and overlay updates), and the fork's
`platform/studyBuddySelection` main-process service. The learning-domain parts of
`extensions/studybuddy` (`@studybuddy` participant, learning tools, StudySpace) are **not** part
of Part 2; they are moved by Part 3 into the private plugin. During the transition both the old
and the new extensions may be installed; the old one yields to the new (section 6).

Rules that apply to every capability in Part 2:

- **P2-FR-001** All AI capabilities MUST be invoked through the Provider extension's API
  (`ILatentProviderApi`, section 4). The Selection extension, the Floating Window, Part 1, and
  Part 3 never call a model endpoint directly.
- **P2-FR-002** The private *Add to Note* feature only registers an extension point in this
  phase. It MUST NOT persist notes, create files, or call a service.
- **P2-FR-003** Existing configuration and credential migration paths MUST be preserved
  (section 6). A user who upgrades keeps every provider, token plan, and secret.

## 2. User flows

### 2.1 Selections and the Selection Bar

- **P2-FR-010** Selection sources: `editor` (Monaco selection in any text editor), `thread`
  (text selected inside a rendered Thread transcript, in Side Chat or the expanded Floating
  Composer), and `system` (text selected in another desktop application, captured by the
  main-process listener based on `selection-hook`). Each Selection is an immutable snapshot
  `{ selectionId, source, text, capturedAt, application?, uri?, range?, threadId?, turnId? }`.
- **P2-FR-011** The Selection Bar appears near the selection without activating the Workbench
  window for `system` selections (existing non-activating overlay), and inside the Workbench for
  `editor` and `thread` selections. It shows the Selection Actions whose `when` clause matches.
- **P2-FR-012** The bar is **draggable** by its grip and **pinnable**. A pinned bar stays visible
  at its dragged position, keeps the current Selection, and updates only when the user presses its
  *Use current selection* control. Unpinned bars follow the selection and hide on dismissal.
- **P2-FR-013** Each action shows its result in the bar's result area (streamed) with **More
  details**, which expands the result and, for Explain/Translate/Summarize, appends a generic,
  provider-neutral explanation of *why* the result reads as it does (source language detected,
  target language used, model used, tokens). *More details* never requires a second model call.
- **P2-FR-014** Editor and thread bars offer *Add to Chat* and *Ask in Side Chat*; system bars
  offer *Add to Chat* only (Part 1 P1-FR-031). `Ask in Side Chat` is visible **only** when the
  Selection source is `thread` (P2-FR-030).
- **P2-FR-015** System-wide selection is enabled by default and can be turned off with
  `latent.selection.system.enabled` (migrated from `latentnote.studyBuddy.globalSelection.enabled`).

### 2.2 Built-in Selection Actions

| Action | Sources | Provider Capability | Behaviour |
| --- | --- | --- | --- |
| Explain | editor, thread, system | `text` | Streams an explanation in the selection's language |
| Translate | editor, thread, system | `text` | Translates into `latent.selection.translate.targetLanguage`; default is the operating-system language (P2-FR-020) |
| Summarize | editor, thread, system | `text` | Streams a summary |
| Add to Chat | all | none | Part 1 `ITabDraftService.addAttachment` |
| Ask in Side Chat | thread only (plugin) | none | Part 1 `ISideChatOpener.open(threadId, origin)`; origin derived from where the transcript is hosted |
| Edit | editor, editable documents only | `text` | Opens an inline composer over the selection (P2-FR-040) |
| Comment | editor (optional) | none | Part 1 P1-FR-033 |
| Add to Note | editor, thread, system | none | Extension point only; the bar shows the action only when a private plugin registered a handler (P2-FR-002) |

- **P2-FR-020** `latent.selection.translate.targetLanguage` is a settings enum of BCP-47 tags
  plus `"os"`. Default `"os"`. `"os"` resolves at action time to the operating-system locale
  provided by the fork command `_latent.platform.osLocale` (which returns
  `platform.platformLocale` from the NLS configuration); when the command is unavailable (stock
  VS Code host), it falls back to `Intl.DateTimeFormat().resolvedOptions().locale` in the
  extension host. The UI display language (`vscode.env.language`) is **not** used.
- **P2-FR-021** Translation output is shown in the bar with a *Translated to <language>* label so
  a wrong default is visible and fixable from the label (opens the setting).

### 2.3 Ask in Side Chat as a plugin

- **P2-FR-030** `Ask in Side Chat` is implemented as a **Selection Action plugin** inside the
  Selection extension: it registers through the same `registerSelectionAction` extension point
  as third parties, with `when: "latent.selection.source == 'thread'"`. Nothing in the bar's core
  knows about it. This keeps the core bar source-agnostic and proves the extension point.

### 2.4 Edit action with inline composer

- **P2-FR-040** For editable documents, the `Edit` action opens the upstream inline chat
  (`inlineChat.start`) anchored on the selection, with a Latent inline participant whose language
  model comes from `ILatentProviderApi.resolve({ capability: 'text', requires: { streaming: true } })`.
  The user states the change; the AI proposes a modification of the selected text as an inline
  diff that the user accepts or discards through the upstream inline chat controls.
- **P2-FR-041** `Edit` is hidden for read-only editors, diff editors, and `thread`/`system`
  sources.

### 2.5 Provider configuration and capability selection

- **P2-FR-050** The Provider extension exposes five Provider Capabilities through one
  **capability-selection model**: `text` (generation, tools, streaming), `imageUnderstanding`,
  `asr` (speech to text, batch and streaming), `tts`, and `realtimeVoice` (full-duplex
  bidirectional audio).
- **P2-FR-051** Each catalog provider and each custom provider declares which capabilities it
  serves, with per-capability protocol, endpoint path, model list, and feature flags. The
  existing OpenMAIC-derived catalog services map as follows: `llm → text` (plus
  `imageUnderstanding` when a model declares `vision`), `asr → asr`, `tts → tts`; `realtimeVoice`
  is a new service id; `image`, `video`, `pdf`, `media-parse`, `web-search` remain configurable
  but out of Part 2's capability model.
- **P2-FR-052** The user selects, per capability, a **default binding** (provider + model). The
  Provider Manager shows a capability matrix (capability × provider) with the active binding
  highlighted, and *Set as default for <capability>* actions.
- **P2-FR-053** When a caller requests a capability that has no usable binding (no provider
  supports it, the provider is disabled, or its credential is missing), the API rejects with
  `CapabilityUnavailableError` and the **UI MUST guide the user**: a notification names the
  capability and the calling feature, with *Configure provider…* opening the Provider Manager
  filtered to providers that declare that capability, and *Learn which providers support this*.
  The same guidance appears inline in the Selection Bar, the Floating Window, and Part 1's
  composer when they are the caller.
- **P2-FR-054** Credentials are stored only in VS Code Secret Storage under the Provider
  extension. The UI never displays a stored secret; it shows presence only.

### 2.6 Floating Window

- **P2-FR-060** A system-level Floating Window exists as an independent OS window, without any
  pet or mascot icon. Properties: fixed compact size (`360 × 132` logical pixels, constant in code,
  not a setting); **always on top** (`alwaysOnTop: true`, level `floating`, visible on all
  workspaces on macOS); **draggable** via its header region (`-webkit-app-region: drag`); **not
  resizable** (`resizable: false`, `fullscreenable: false`, `maximizable: false`); **not closable
  from the window itself** (`closable: false`, no close control, `Cmd/Ctrl+W` ignored, `close`
  event prevented while enabled).
- **P2-FR-061** The window contains: a one-line composer; a **New Thread** button; a **Voice**
  toggle; a status dot for the active `text`/`realtimeVoice` binding.
- **P2-FR-062** *New Thread* creates a Thread through Part 1 and opens it **in the Editor Area**
  of the most recently active Workbench window (origin `floatingWindow`), restoring or creating a
  window if none is open. Text typed in the Floating Window becomes the first message.
- **P2-FR-063** *Voice* starts **full-duplex voice mode** through the `realtimeVoice` binding:
  microphone audio streams to the provider while synthesized audio plays back, with barge-in
  (user speech interrupts playback). The transcript of both sides is appended as Turns to the
  Thread the Floating Window is bound to (its last New Thread, or a new one). If `realtimeVoice`
  has no binding, the window offers a fallback chain `asr + text + tts` when those three are bound,
  otherwise shows the P2-FR-053 guidance.
- **P2-FR-064** The Floating Window can be disabled **only** from the main application's
  settings: `latent.floatingWindow.enabled` (default `true` once Part 2 ships, user scope).
  Disabling hides and destroys the window; enabling recreates it. There is no per-window disable,
  no tray toggle, and no keyboard shortcut that closes it.
- **P2-FR-065** The window position is remembered per display arrangement and clamped to the
  nearest display's work area on show.

## 3. Module boundaries

```text
extensions/latent-selection/
├─ src/extension.ts                 activation, migration of latentnote.studyBuddy.globalSelection.enabled
├─ src/selection/                   snapshot model (from editor/selection.ts), sources (editor, thread, system)
├─ src/bar/                         SelectionBar controller: placement, drag, pin, result area, More details
├─ src/actions/                     registry + built-ins (explain, translate, summarize, addToChat, edit, comment)
├─ src/plugins/askInSideChat.ts     plugin registered through the public extension point
├─ src/extensionPoints/             registerSelectionAction, registerAddToNoteHandler (no persistence)
└─ src/api.ts                       ILatentSelectionApi (exports)

extensions/latent-provider/
├─ src/extension.ts                 activation, state and secret migration
├─ src/catalog/                     provider-catalog.yaml → json (existing compile script)
├─ src/store/                       ProviderStore (existing), capability defaults
├─ src/capabilities/                text, imageUnderstanding, asr, tts, realtimeVoice adapters
├─ src/languageModel/               vscode.lm registration (vendor latentnote-catalog)
├─ src/manager/                     Provider Manager webview (existing), capability matrix
└─ src/api.ts                       ILatentProviderApi (exports)

src/vs/platform/latentSelection/{common,electron-main}/     system listener + overlay window (moved from studyBuddySelection)
src/vs/platform/latentFloatingWindow/{common,electron-main}/  FloatingWindowMainService
src/vs/workbench/contrib/latent/browser/floatingWindow/        renderer for the floating window, voice session
src/vs/workbench/contrib/latent/browser/selection/             editor + thread selection bridge to the extension
```

- **P2-FR-070** The Selection extension MUST NOT import provider code; it depends on
  `ILatentProviderApi` obtained through `vscode.extensions.getExtension('latentnote.latent-provider')?.exports`
  and degrades to *Configure provider…* guidance when the Provider extension is missing.
- **P2-FR-071** The Provider extension MUST NOT know about the Selection Bar, Threads, or the
  Floating Window. It exposes capabilities and the language-model registration only.
- **P2-FR-072** The main process owns exactly one system selection listener and one overlay
  window (unchanged from today), and exactly one Floating Window. Both are registered through
  the existing `latent.contribution.ts` seams.
- **P2-FR-073** The Floating Window renderer is a minimal fork-owned page (no full workbench)
  that talks to the main process over a dedicated IPC channel; Thread creation and voice
  transcript writes go through the main process to the target Workbench window's
  `IThreadService` (Part 1) using the existing window-targeting pattern of the selection service.

## 4. Extension interfaces

```ts
// extensions/latent-selection/src/api.ts
export type SelectionSource = 'editor' | 'thread' | 'system';

export interface ISelectionSnapshot {
	readonly selectionId: string;
	readonly source: SelectionSource;
	readonly text: string;
	readonly capturedAt: number;
	readonly application?: string;      // system
	readonly uri?: string;              // editor
	readonly range?: { start: { line: number; character: number }; end: { line: number; character: number } };
	readonly languageId?: string;       // editor
	readonly threadId?: string;         // thread
	readonly turnId?: string;           // thread
	readonly editable: boolean;         // true for editor selections in writable documents
}

export interface ISelectionActionContext {
	readonly selection: ISelectionSnapshot;
	readonly bar: { report(update: { phase: 'running' | 'succeeded' | 'failed'; text?: string; details?: string }): void };
	readonly token: vscode.CancellationToken;
}

export interface ISelectionActionDescriptor {
	readonly id: string;                 // e.g. 'latent.selection.explain'
	readonly title: string;              // localized, title-style
	readonly icon?: string;              // codicon id
	readonly order: number;
	/** Context-key expression over `latent.selection.source`, `latent.selection.editable`, `latent.selection.languageId`. */
	readonly when?: string;
	readonly requires?: readonly ProviderCapability[]; // bar shows guidance instead of running when unbound
	run(context: ISelectionActionContext): Promise<void>;
}

export interface IAddToNoteHandler {
	/** Registration only in this phase. The bar shows "Add to Note" when a handler exists. */
	readonly id: string;
	handle(selection: ISelectionSnapshot): Promise<void>;
}

export interface ILatentSelectionApi {
	readonly version: 1;
	registerSelectionAction(descriptor: ISelectionActionDescriptor): vscode.Disposable;
	registerAddToNoteHandler(handler: IAddToNoteHandler): vscode.Disposable;
	readonly onDidCaptureSelection: vscode.Event<ISelectionSnapshot>;
	getCurrentSelection(): ISelectionSnapshot | undefined;
	pin(pinned: boolean): void;
}
```

```ts
// extensions/latent-provider/src/api.ts
export type ProviderCapability = 'text' | 'imageUnderstanding' | 'asr' | 'tts' | 'realtimeVoice';

export interface ICapabilityRequest {
	readonly capability: ProviderCapability;
	readonly requires?: {
		readonly streaming?: boolean;
		readonly tools?: boolean;
		readonly languages?: readonly string[];   // asr/tts
		readonly duplex?: boolean;                // realtimeVoice
	};
	readonly preferredProviderId?: string;
	readonly preferredModelId?: string;
}

export interface ICapabilityBinding {
	readonly capability: ProviderCapability;
	readonly providerId: string;
	readonly providerName: string;
	readonly modelId: string;
	readonly protocol: string;                    // openai | anthropic | google | openai-realtime | ...
	readonly features: Readonly<Record<string, boolean | string[]>>;
}

export class CapabilityUnavailableError extends Error {
	constructor(readonly capability: ProviderCapability, readonly reason: 'noProvider' | 'disabled' | 'missingCredential' | 'unsupportedRequirement', readonly candidates: readonly string[]) { super(); }
}

export interface ITextGenerateOptions { messages: vscode.LanguageModelChatMessage[]; tools?: vscode.LanguageModelChatTool[]; }
export interface IImageUnderstandOptions { image: Uint8Array; mimeType: string; prompt: string; }
export interface IAsrOptions { audio: AsyncIterable<Uint8Array> | Uint8Array; mimeType: string; language?: string; }
export interface ITtsOptions { text: string; voiceId?: string; language?: string; format?: 'pcm16' | 'mp3' | 'ogg'; }
export interface IRealtimeSessionOptions { language?: string; voiceId?: string; instructions?: string; }

export interface IRealtimeVoiceSession extends vscode.Disposable {
	sendAudio(chunk: Uint8Array): void;           // pcm16 mono
	readonly onAudio: vscode.Event<Uint8Array>;   // synthesized audio
	readonly onTranscript: vscode.Event<{ role: 'user' | 'assistant'; text: string; final: boolean }>;
	interrupt(): void;                            // barge-in
}

export interface ILatentProviderApi {
	readonly version: 1;
	readonly onDidChangeBindings: vscode.Event<void>;
	resolve(request: ICapabilityRequest): Promise<ICapabilityBinding>;      // throws CapabilityUnavailableError
	listBindings(capability: ProviderCapability): Promise<readonly ICapabilityBinding[]>;
	/** Opens the guidance flow of P2-FR-053 for a capability. */
	guide(capability: ProviderCapability, caller: string): Promise<void>;
	text(binding: ICapabilityBinding, options: ITextGenerateOptions, token: vscode.CancellationToken): AsyncIterable<vscode.LanguageModelResponsePart>;
	understandImage(binding: ICapabilityBinding, options: IImageUnderstandOptions, token: vscode.CancellationToken): Promise<string>;
	transcribe(binding: ICapabilityBinding, options: IAsrOptions, token: vscode.CancellationToken): AsyncIterable<{ text: string; final: boolean }>;
	synthesize(binding: ICapabilityBinding, options: ITtsOptions, token: vscode.CancellationToken): AsyncIterable<Uint8Array>;
	openRealtimeSession(binding: ICapabilityBinding, options: IRealtimeSessionOptions): Promise<IRealtimeVoiceSession>;
}
```

Contribution points and commands:

| Point / command | Owner | Purpose |
| --- | --- | --- |
| `latentSelectionActions` (package.json contribution) | Selection | Declarative actions: `{ id, title, icon, when, requires, command }`; the command receives an `ISelectionSnapshot` |
| `ILatentSelectionApi.registerSelectionAction` | Selection | Programmatic actions (used by `Ask in Side Chat` and by Part 3) |
| `ILatentSelectionApi.registerAddToNoteHandler` | Selection | Private plugin registers a handler; no persistence in Part 2 |
| `latentProviderCapabilities` (package.json contribution) | Provider | Third-party extensions declare additional providers or protocols for a capability |
| `latent.provider.manage` | Provider | Opens the Provider Manager (alias of `latentnote.manageProviders`) |
| `latent.provider.configureCapability` (arg: capability) | Provider | Opens the manager filtered for P2-FR-053 |
| `latent.floatingWindow.newThread`, `latent.floatingWindow.toggleVoice` | Workbench (fork) | Invoked by the Floating Window renderer |
| `_latent.platform.osLocale` | Workbench (fork) | Returns the OS locale for P2-FR-020 |

Context keys: `latent.selection.source`, `latent.selection.editable`, `latent.selection.languageId`,
`latent.selection.pinned`, `latent.floatingWindow.voiceActive`.

## 5. Failure states

| Situation | Behaviour |
| --- | --- |
| `selection-hook` native module missing or fails to start; macOS Accessibility not granted | System selection reports *unavailable in this build* / *grant Accessibility*, editor and thread selections keep working; no crash; `latent.selection.system.enabled` stays as set |
| Selection empty or over 50,000 characters | No bar for empty; long selections truncated at capture with a *truncated* badge in the bar |
| Action requires an unbound capability | Bar shows the P2-FR-053 guidance inline instead of running |
| Provider extension not installed | Selection actions needing a model are shown disabled with *Install/enable the Latent Provider extension*; Add to Chat and Ask in Side Chat still work |
| Model request fails (network, 4xx/5xx, rate limit) | Bar shows the provider's error text, *Retry*, and *Change provider*; the failure is not cached |
| Stale action result (selection changed before completion) | Result for an old `selectionId` is dropped, never shown over a newer selection (existing `updateOverlay` guard retained) |
| Pinned bar's Selection source closes (document closed, Thread deleted) | Bar shows *Selection no longer available* and offers unpin |
| Edit action on a document that changed under the inline composer | Upstream inline chat conflict handling applies; the proposed edit is discarded with a notice |
| Translate default cannot be resolved | Falls back to `en`, labelled *Translated to English (default could not be detected)* |
| Secret Storage unavailable (keychain locked) | Provider shows *credentials unavailable*; bindings that require a credential are reported `missingCredential`; nothing is deleted |
| Catalog JSON invalid | Provider falls back to the last compiled catalog shipped with the build and logs the error |
| `realtimeVoice` session drops | Floating Window shows *Reconnecting…* for up to 10 s, then ends voice mode and keeps the transcript captured so far |
| Microphone permission denied | Voice toggle shows the OS guidance; no session is opened |
| Floating Window cannot be created (display or window manager error) | Setting stays `true`; the status bar shows *Floating window unavailable* with *Retry* |
| Target Workbench window for New Thread is missing | A new window is opened on the last workspace, then the Thread opens there |

## 6. Migration strategy

Starting points: the existing floating composer (Part 1 migration step 1), the existing
`_openInSideChat` logic, and `extensions/studybuddy/src/providers/*`.

1. **Extension split.** Create the two extensions by moving files, not rewriting them:
   `providers/{catalog,store,identity,languageModel,manager}.ts` and `media/provider-*` move to
   `latent-provider`; `editor/selection.ts` and the selection parts of
   `learning/explanationController.ts` move to `latent-selection`. Register both in
   `build/gulpfile.extensions.ts` and `build/npm/dirs.ts` next to the existing entry.
2. **Settings migration** (performed once per profile by each new extension on activation, and
   also honoured as a read fallback until the next major release):

   | Old key | New key |
   | --- | --- |
   | `latentnote.studyBuddy.globalSelection.enabled` | `latent.selection.system.enabled` |
   | `chat.customProviders.enabled` | `latent.provider.enabled` |
   | (new) | `latent.selection.translate.targetLanguage` = `"os"` |
   | (new) | `latent.floatingWindow.enabled` = `true` |

3. **Credential migration.** VS Code Secret Storage scopes secrets by extension identifier. The
   existing secrets are stored under `latentnote.latentnote-study-buddy` with keys
   `customProviders.secret.v1.<service>:<providerId>[.<slot>]` and `customProviders.secret.v1.plan:<planId>`;
   the new Provider extension cannot read them through the extension API. Migration is therefore
   performed by a **fork-owned Workbench contribution** (`contrib/latent/browser/providerSecretMigration.ts`)
   that, once per profile, uses `ISecretStorageService` to copy every secret whose key
   decodes to `{ extensionId: 'latentnote.latentnote-study-buddy', key: 'customProviders.secret.v1.*' }`
   to `{ extensionId: 'latentnote.latent-provider', key: <same key> }`, then writes the marker
   `latent.provider.secretMigration.v1 = done` in profile storage. The old secrets are left in
   place until the old extension is removed. On stock VS Code (no fork contribution), the
   Provider extension shows a one-time *Re-enter credentials* notice per provider.
4. **Provider state migration.** `customProviders.state.v1` (global state of the old extension)
   is exported by the old extension through the command `latentnote.studyBuddy.exportProviderState`
   and imported by the new one on first activation; the new state key is
   `latent.provider.state.v2` with `capabilityDefaults` added. When the old extension is absent,
   the Workbench contribution above also copies the global-state blob (same fork-owned path).
5. **Language-model vendor.** The vendor id `latentnote-catalog` and model ids
   (`provider:<id>/<model>`, `plan:<id>/<model>`, `studybuddy-service`) are unchanged so that the
   Floating Composer's `requestModelByIdentifier` and users' saved model selections keep working.
   The `studybuddy-service` model moves to Part 3 and is registered there when the private
   plugin is present.
6. **Selection main-process service.** `platform/studyBuddySelection` is renamed to
   `platform/latentSelection` in one commit with the IPC channel name kept as
   `studyBuddySelection` for one release, then renamed with a compatibility alias.
7. **Old extension coexistence.** If `latentnote.latentnote-study-buddy` is still installed, it
   detects `latentnote.latent-provider` and `latentnote.latent-selection` and deactivates its
   duplicated commands and providers, leaving only the learning features that Part 3 will move.
8. **Floating Window.** New code; ships enabled. First run shows a one-time hint that it can be
   turned off in Settings.

## 7. Acceptance scenarios

Harness legend as in Part 1.

| ID | Scenario | Harness |
| --- | --- | --- |
| P2-AS-001 | **Drag and pin.** Given an editor selection with the bar shown, When the bar is dragged 200 px and pinned, Then it stays at the new position after the selection is cleared, keeps the old Selection text, and updates only after *Use current selection*. | P |
| P2-AS-002 | **More details.** Given an Explain result, When *More details* is expanded, Then the full result plus detected language, model, and provider are shown and no additional model request was made (request counter unchanged). | U + P |
| P2-AS-003 | **Extension point.** Given a test extension registering `{ id: 'test.shout', when: "latent.selection.source == 'editor'" }`, When an editor selection is made, Then *Shout* appears; When a system selection is made, Then it does not. | S |
| P2-AS-004 | **Ask in Side Chat only in threads.** Given selections in an editor, in a Thread transcript, and in another application, Then *Ask in Side Chat* is visible only for the Thread selection, and disabling the plugin module removes it without other bar changes. | P |
| P2-AS-005 | **Translate default.** Given OS locale `zh-CN` and UI language `en`, When Translate runs with `targetLanguage: "os"`, Then the request's target is `zh-CN` and the bar reads *Translated to 中文（简体）*; setting `targetLanguage: "ja"` changes both. | U |
| P2-AS-006 | **Edit action.** Given a selection in a writable Markdown file, When *Edit* runs with the instruction "make it a bullet list", Then the upstream inline chat opens over the selection, an inline diff is proposed through the `text` binding, and *Accept* applies it; a read-only editor shows no *Edit*. | P |
| P2-AS-007 | **Capability matrix.** Given providers A (`text`, `asr`) and B (`text`, `tts`, `realtimeVoice`), When the Provider Manager opens, Then the matrix shows exactly those cells and *Set as default* per capability persists to `capabilityDefaults`. | U + P |
| P2-AS-008 | **Missing capability guidance.** Given no provider with `asr`, When the Floating Window's voice fallback requests `asr`, Then `CapabilityUnavailableError('asr', 'noProvider')` is raised and a notification with *Configure provider…* opens the manager filtered to `asr`-capable providers. | U + P |
| P2-AS-009 | **Credential presence only.** Given a stored API key, When the manager renders, Then the key is never present in the webview DOM or messages (only `hasSecret: true`). | U |
| P2-AS-010 | **Floating Window properties.** Given the window is enabled, Then `getSize()` is `[360, 132]` before and after a resize attempt, `isAlwaysOnTop()` is true, dragging the header moves it, `isResizable()`/`isClosable()` are false, and `Cmd/Ctrl+W` and `window.close()` leave it open. | S (Electron main test) |
| P2-AS-011 | **New Thread from Floating Window.** Given text "plan my week" typed, When *New Thread* is clicked, Then a Thread with that first Turn opens as a chat editor in the Editor Area of the last active Workbench window. | S |
| P2-AS-012 | **Voice interaction.** Given a `realtimeVoice` binding, When *Voice* is toggled and 3 s of audio is streamed, Then `onTranscript` yields a user transcript, `onAudio` yields playback, speaking again during playback calls `interrupt()`, and both transcripts are appended as Turns. | S (mock realtime provider) + M |
| P2-AS-013 | **Disable only from settings.** Given the window is shown, Then no control on it, no tray item, and no keybinding hides it; When `latent.floatingWindow.enabled` is set to `false` in Settings, Then it is destroyed; setting `true` recreates it at its last position. | S |
| P2-AS-014 | **Credential migration.** Given a profile with secrets under the old extension id for providers `llm:openai` and plan `plan:x`, When the new build starts, Then `listBindings('text')` includes both without user input, the migration marker is set, and a second start does not copy again. | S |
| P2-AS-015 | **Settings migration.** Given `latentnote.studyBuddy.globalSelection.enabled: false` and `chat.customProviders.enabled: true`, When the new extensions activate, Then `latent.selection.system.enabled` is `false` and `latent.provider.enabled` is `true` in user settings. | U |
| P2-AS-016 | **Model ids preserved.** Given a saved selection of `latentnote-catalog/provider:openai/gpt-x`, When the composer restores, Then the same model is selected through the new extension. | S |
| P2-AS-017 | **Add to Note is registration only.** Given a test handler registered, When *Add to Note* runs, Then the handler receives the snapshot and no file, storage key, or network request is created by the Selection extension. | U |
| P2-AS-018 | **All AI through providers.** Given network egress recorded during Explain, Translate, Summarize, Edit, and voice, Then every model request originates from the Provider extension's adapters (static import check that no other module imports `fetch` wrappers for model hosts). | U |

## 8. Reuse inventory

Inventory date: 2026-09-18.

| Component | Upstream version | Source | License | Notices to retain | Use in Part 2 |
| --- | --- | --- | --- | --- | --- |
| `selection-hook` | 2.0.1 (already a dependency) | https://github.com/0xfullex/selection-hook | MIT | "Copyright (c) 2025 0xfullex"; **not yet listed in `ThirdPartyNotices.txt` — add it** | System selection listener (native) |
| OpenMAIC provider catalog | catalog source `OpenMAIC-main` (see `media/provider-catalog.yaml`); upstream THU-MAIC/OpenMAIC | https://github.com/THU-MAIC/OpenMAIC | MIT | Add MIT notice for the catalog data to `ThirdPartyNotices.txt`; record the upstream commit in the YAML header | Provider catalog categories, providers, token plans |
| Code-OSS inline chat, chat, language model API, secret storage | this fork | in-tree | MIT | existing | Edit action, model registration, credentials |
| Electron `BrowserWindow` | in-tree dependency | in-tree | MIT | existing | Floating Window, selection overlay |
| Hermes Agent voice/TTS/ASR tool structure | v2026.9.14 | https://github.com/NousResearch/hermes-agent (`tools/voice_live.py`, `tools/tts_tool*.py`, `tools/transcription_*.py`) | MIT | as in Part 1 | Behavioural reference for the `asr`/`tts`/`realtimeVoice` adapters; ported, not copied |

No restrictive-license component is incorporated. All listed licenses permit commercial use.
