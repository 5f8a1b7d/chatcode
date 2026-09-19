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
  *Use current selection* control. Unpinned bars follow the selection and hide when the user
  clicks or presses outside the bar and any of its open popovers, including blank editor or
  desktop space, or presses Escape. A click inside the bar or its optional comment input does
  not dismiss it; outside clicks do not consume the underlying target's normal click.
- **P2-FR-013** Each action shows its result in the bar's result area (streamed) with **More
  details**, which expands the result and, for Explain/Translate/Summarize, appends a generic,
  provider-neutral explanation of *why* the result reads as it does (source language detected,
  target language used, model used, tokens). *More details* never requires a second model call.
- **P2-FR-014** Editor and thread bars offer *Add to Chat* and *Ask in Side Chat*; system bars
  offer *Add to Chat* only (Part 1 P1-FR-031). An editor selection uses its Tab's active Thread
  (creating one if needed); a Thread-transcript selection creates a new Thread in the opposite
  host, with the source Thread and Turn recorded on its Selection Attachment. The action must
  remain discoverable and clickable in both bar types.
- **P2-FR-015** System-wide selection is enabled by default and can be turned off with
  `latent.selection.system.enabled` (migrated from `latentnote.studyBuddy.globalSelection.enabled`).
- **P2-FR-016** Completing a non-empty text selection inside a Thread transcript in either the
  Editor Area or Secondary Side Bar automatically copies exactly the selected plain text to the
  system clipboard, without requiring a Copy action. Commit the copy once when a mouse or
  keyboard selection settles, not on each intermediate drag update. An empty selection and
  selections in document editors or external applications do not change the clipboard through
  this rule. Copying does not dismiss the Selection Bar or change the source Thread.

### 2.2 Built-in Selection Actions

| Action | Sources | Provider Capability | Behaviour |
| --- | --- | --- | --- |
| Explain | editor, thread, system | `text` | Streams an explanation in the selection's language |
| Translate | editor, thread, system | `text` | Translates into `latent.selection.translate.targetLanguage`; default is the operating-system language (P2-FR-020) |
| Summarize | editor, thread, system | `text` | Streams a summary |
| Add to Chat | all | none | Part 1 `ITabDraftService.addAttachment` |
| Ask in Side Chat | editor, thread (plugin) | none | Document-editor selection targets its Tab's Thread; Thread-transcript selection creates a new Thread with source provenance in the opposite host |
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
  as third parties, with a `when` expression matching `editor` or `thread` source. It resolves
  the document editor Tab's active Thread or creates a new Thread from a transcript Selection,
  then applies Part 1's opposite-host rule using the transcript's actual host. Nothing in the
  bar's core knows about it. This keeps the core bar source-agnostic and proves the extension
  point.

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
- **P2-FR-055** Provider definitions, endpoint URLs, enabled state, model lists, and capability
  defaults MUST survive application and extension-host restarts in the same development profile;
  credentials survive through persistent Secret Storage. `scripts/code-min.sh` MUST reuse one
  stable, repository-specific development profile under the OS user-data directory by default,
  rather than discarding it or using in-memory Secret Storage. `--fresh-profile` creates a
  disposable isolated profile for tests. No credential is written to the repository, shell
  history, logs, or a checked-in settings file.
- **P2-FR-056** `realtimeVoice` has separate protocol adapters for a user-run local
  [Kyutai Moshi](https://github.com/kyutai-labs/moshi), user-run
  [NVIDIA Nemotron VoiceChat](https://github.com/NVIDIA/NeMo-Speech.cpp) and
  [PersonaPlex](https://github.com/NVIDIA/personaplex), and hosted
  [Google Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api). These are distinct
  bindings; the Provider Manager shows the protocol, local/hosted location, endpoint, model,
  and whether the backend supplies user and assistant transcripts and interruption. For local
  bindings, the app connects to an already running service; it does not silently download model
  weights, install runtimes, or start a public network listener. PersonaPlex maps the common
  `instructions` and `voiceId` options to its text persona and voice prompt controls; the
  Provider Manager exposes those options only when that binding is selected.
- **P2-FR-057** Every realtime adapter normalizes connection, audio encoding and sample rate,
  partial/final transcripts, playback, interruption, errors, and cleanup into
  `IRealtimeVoiceSession`. If a backend cannot supply a required transcript itself, the binding
  requires an explicit compatible `asr` binding for that side; an unavailable prerequisite is
  reported through P2-FR-053 before opening the microphone. `interrupt()` stops queued playback
  as well as notifying the backend. The provider adapter must not label a one-way ASR/TTS chain
  as native full-duplex support.
- **P2-FR-058** Local Moshi, VoiceChat, and PersonaPlex endpoints default to loopback and use
  each backend's documented transport; Gemini Live uses its own WebSocket session protocol.
  They are not routed through the OpenAI Realtime URL builder. Credentials, when required, come
  from Secret Storage. If a backend requires query-string WebSocket authentication (as Gemini
  Live's raw WebSocket API currently does), construct the authenticated URL only in the
  privileged adapter, prefer short-lived credentials when supported, and redact the URL from
  logs, telemetry, exceptions, and renderer-visible state. Never persist that URL.

### 2.6 Floating Window

- **P2-FR-060** A system-level Floating Window exists as an independent OS window, without any
  pet or mascot icon. It fits its content: `360 × 80` logical pixels while idle, with the empty
  transcript area collapsed, and `360 × 116` while a voice transcript is visible. It leaves no
  large blank region below the controls. The user cannot resize it; these heights are application
  state, not a setting. It is **always on top** (`alwaysOnTop: true`, level `floating`, visible on all
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
│  └─ realtime/                      OpenAI Realtime, Moshi, VoiceChat, PersonaPlex, Gemini Live transports
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
	readonly protocol: string;                    // openai | anthropic | google | openai-realtime | moshi | nemotron-voicechat | personaplex | gemini-live | ...
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
| Thread selection cannot be copied to the system clipboard | Keep the Selection and bar usable; show a non-blocking copy error and never substitute a stale clipboard value for the selected text |
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
| Local realtime backend is not running, incompatible, or lacks a required transcript stream | Provider Manager identifies the failing backend/prerequisite; the voice control offers configuration guidance and leaves the current Thread and Draft intact |
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
9. **Persistent development profile.** The default `scripts/code-min.sh` launch reuses a stable
   per-repository user-data directory and persistent Secret Storage. Existing temporary preview
   behavior moves behind an explicit fresh-profile flag for isolated QA. Do not copy secrets from
   an old disposable profile that has already been removed; the user enters them once into the
   new persistent profile.

## 7. Acceptance scenarios

Harness legend as in Part 1.

| ID | Scenario | Harness |
| --- | --- | --- |
| P2-AS-001 | **Drag and pin.** Given an editor selection with the bar shown, When the bar is dragged 200 px and pinned, Then it stays at the new position after the selection is cleared, keeps the old Selection text, and updates only after *Use current selection*. | P |
| P2-AS-002 | **More details.** Given an Explain result, When *More details* is expanded, Then the full result plus detected language, model, and provider are shown and no additional model request was made (request counter unchanged). | U + P |
| P2-AS-003 | **Extension point.** Given a test extension registering `{ id: 'test.shout', when: "latent.selection.source == 'editor'" }`, When an editor selection is made, Then *Shout* appears; When a system selection is made, Then it does not. | S |
| P2-AS-004 | **Ask in Side Chat plugin.** Given selections in a document editor, in Thread transcripts hosted in each Workbench pane, and in another application, Then *Ask in Side Chat* appears for editor and Thread selections only; document-editor selection targets its Tab's Thread, while each Thread selection creates a new Thread in the opposite host. Disabling the plugin removes only that action. | P |
| P2-AS-005 | **Translate default.** Given OS locale `zh-CN` and UI language `en`, When Translate runs with `targetLanguage: "os"`, Then the request's target is `zh-CN` and the bar reads *Translated to 中文（简体）*; setting `targetLanguage: "ja"` changes both. | U |
| P2-AS-006 | **Edit action.** Given a selection in a writable Markdown file, When *Edit* runs with the instruction "make it a bullet list", Then the upstream inline chat opens over the selection, an inline diff is proposed through the `text` binding, and *Accept* applies it; a read-only editor shows no *Edit*. | P |
| P2-AS-007 | **Capability matrix.** Given providers A (`text`, `asr`) and B (`text`, `tts`, `realtimeVoice`), When the Provider Manager opens, Then the matrix shows exactly those cells and *Set as default* per capability persists to `capabilityDefaults`. | U + P |
| P2-AS-008 | **Missing capability guidance.** Given no provider with `asr`, When the Floating Window's voice fallback requests `asr`, Then `CapabilityUnavailableError('asr', 'noProvider')` is raised and a notification with *Configure provider…* opens the manager filtered to `asr`-capable providers. | U + P |
| P2-AS-009 | **Credential presence only.** Given a stored API key, When the manager renders, Then the key is never present in the webview DOM or messages (only `hasSecret: true`). | U |
| P2-AS-010 | **Compact Floating Window properties.** Given the window is idle, Then `getSize()` is `[360, 80]` with no reserved empty transcript area; while a voice transcript is visible it is `[360, 116]`. A user resize attempt changes neither state size, `isAlwaysOnTop()` is true, header drag moves it, `isResizable()`/`isClosable()` are false, and `Cmd/Ctrl+W` and `window.close()` leave it open. | S (Electron main test) + P |
| P2-AS-011 | **New Thread from Floating Window.** Given text "plan my week" typed, When *New Thread* is clicked, Then a Thread with that first Turn opens as a chat editor in the Editor Area of the last active Workbench window. | S |
| P2-AS-012 | **Voice interaction.** Given a `realtimeVoice` binding, When *Voice* is toggled and 3 s of audio is streamed, Then `onTranscript` yields a user transcript, `onAudio` yields playback, speaking again during playback calls `interrupt()`, and both transcripts are appended as Turns. | S (mock realtime provider) + M |
| P2-AS-013 | **Disable only from settings.** Given the window is shown, Then no control on it, no tray item, and no keybinding hides it; When `latent.floatingWindow.enabled` is set to `false` in Settings, Then it is destroyed; setting `true` recreates it at its last position. | S |
| P2-AS-014 | **Credential migration.** Given a profile with secrets under the old extension id for providers `llm:openai` and plan `plan:x`, When the new build starts, Then `listBindings('text')` includes both without user input, the migration marker is set, and a second start does not copy again. | S |
| P2-AS-015 | **Settings migration.** Given `latentnote.studyBuddy.globalSelection.enabled: false` and `chat.customProviders.enabled: true`, When the new extensions activate, Then `latent.selection.system.enabled` is `false` and `latent.provider.enabled` is `true` in user settings. | U |
| P2-AS-016 | **Model ids preserved.** Given a saved selection of `latentnote-catalog/provider:openai/gpt-x`, When the composer restores, Then the same model is selected through the new extension. | S |
| P2-AS-017 | **Add to Note is registration only.** Given a test handler registered, When *Add to Note* runs, Then the handler receives the snapshot and no file, storage key, or network request is created by the Selection extension. | U |
| P2-AS-018 | **All AI through providers.** Given network egress recorded during Explain, Translate, Summarize, Edit, and voice, Then every model request originates from the Provider extension's adapters (static import check that no other module imports `fetch` wrappers for model hosts). | U |
| P2-AS-019 | **Outside click dismisses Selection Bar.** Given an unpinned bar over an editor or system selection, When blank space outside it is clicked, Then the bar closes and the click still reaches its target; a click inside the bar or comment popover leaves it open, and a pinned bar stays visible. | P |
| P2-AS-020 | **Document-editor Ask in Side Chat.** Given a selection in `a.md` with no active Thread, When the Selection Bar's *Ask in Side Chat* is clicked, Then it creates a Thread bound to that Tab, adds the selected text with URI and range, opens the Secondary Side Bar, and focuses the input. Thread-transcript selections follow P1-AS-033/034 and create a different Thread. | P |
| P2-AS-021 | **Local Moshi voice.** Given a local Moshi server and any required companion ASR binding, When its `realtimeVoice` binding is selected and Voice runs, Then audio flows both ways, both final transcripts are recorded, interruption stops playback, and disconnect leaves the Thread intact. | S + M |
| P2-AS-022 | **NVIDIA local voice.** Given user-run Nemotron VoiceChat and PersonaPlex servers in separate fixtures, When each binding is selected in turn, Then its adapter negotiates its own transport, streams audio, records both sides' transcripts (using an explicit ASR binding if required), and handles interruption and shutdown without OpenAI Realtime URL construction. | S + M |
| P2-AS-023 | **Gemini Live voice.** Given a Gemini Live binding in Secret Storage, When Voice runs, Then the Live WebSocket session streams audio and transcripts, interruption works, the renderer receives no credential or authenticated URL, and logs redact authentication data. | S + M |
| P2-AS-024 | **Provider survives development restart.** Given a provider URL, credential, selected model, and capability default saved during one `scripts/code-min.sh` launch, When that process exits and the script starts again for the same repository, Then the provider is enabled and usable without re-entry; the Manager shows credential presence only. An explicit fresh-profile launch remains isolated. | S + M |
| P2-AS-025 | **Thread selection copies text.** Given a sentinel clipboard value and a Thread transcript in either the Editor Area or Secondary Side Bar, When a non-empty phrase is selected with mouse or keyboard, Then the clipboard contains exactly that phrase once the selection settles; the bar remains usable, the source Thread is unchanged, and clearing the selection does not overwrite the clipboard. | P |

### Manual QA snapshot — 2026-09-18

The run used `scripts/code-min.sh` and a Qwen **text** binding. **Partial** identifies the
properties actually observed. **Blocked** records missing setup, not a failed adapter. P2-AS-010
was tested against its former `360 × 132` expectation; the revised compact height above has not
been retested.

| ID | Result | Observed evidence / remaining gap |
| --- | --- | --- |
| P2-AS-010 | Partial under old expectation | The window measured `360 × 132` and stayed open after Cmd+W; Electron properties and the new compact sizes were not verified. |
| P2-AS-011 | Pass | `New Thread` opened a chat editor with `plan my week` as its first Turn. |
| P2-AS-012 | Blocked | Voice requested a `realtimeVoice` provider; only Qwen text was configured. |
| P2-AS-013 | Partial | Changing the setting destroyed and recreated the window; last position and tray behavior were not verified. |

### Additional field observations — 2026-09-19

These are user reports with screenshots, not a second independent manual run. The numbered items
refer to the accompanying QA feedback.

| User item | Observation | Requirement / next check |
| --- | --- | --- |
| 1 | The global Floating Window leaves a large blank area below its controls. | P2-FR-060; retest P2-AS-010 in idle and voice states. |
| 3 | More realtime voice backends are needed: local Moshi, Nemotron VoiceChat/PersonaPlex, and Gemini Live. | P2-FR-056–058; P2-AS-021–023. |
| 4 | Clicking blank space outside the Selection Bar does not close it. | P2-FR-012; P2-AS-019. |
| 9 | Provider configuration must persist across development launches. The current `code-min` launcher uses a disposable profile and in-memory secrets. | P2-FR-055; P2-AS-024. |
| 10 | The Selection Bar does not show *Ask in Side Chat* where expected. The old spec contradicted itself by promising editor support but limiting the plugin to Thread selections. | P2-FR-014/030; P2-AS-004/020. |
| Follow-up: Thread Ask | A Thread selection in either host should show *Ask in Side Chat* and create a new Thread in the opposite host. | P2-FR-014/030; P2-AS-004 and P1-AS-033/034. |
| Follow-up: clipboard | Selecting text in a Thread does not automatically copy it to the clipboard. | P2-FR-016; P2-AS-025. |

### Fix implementation and computer-use retest — 2026-09-19

| Scenario | Latest result | Evidence / qualification |
| --- | --- | --- |
| P2-AS-010 | Fix applied; partial UI check | Idle global window height is now 80 logical pixels; transcript content grows it to 116. Empty transcript space is hidden. The native window was used during the run; idle/voice sizing, dragging and multi-display edges still require a complete geometry retest. |
| P2-AS-011 | Pass for opening | Global New Thread opened an editor conversation in the live run. The baseline already verified first-turn text; that exact payload check was not repeated after the final changes. |
| P2-AS-012 | Blocked for live voice | Qwen text is configured; no local voice server or Gemini Live credential was supplied. Protocol/bridge tests do not establish microphone, audible duplex, latency or interruption quality. |
| P2-AS-013 | Partial | Normal app Quit succeeded after adding the before-shutdown guard. Settings toggle was verified in the baseline; tray/position behavior remains unverified in this pass. |
| P2-AS-019 | Fix applied; manual retest required | Workbench pointer-down, native outside mouse-down and overlay blur hide an unpinned Selection Bar; pinned handling is retained. Blank-area dismissal and pinned exceptions were not independently certified after the final main-process rebuild. |
| P2-AS-020 | Partial | Code and both transcript hosts displayed Ask in Side Chat. Optional code-selection comment flow passed. Opposite-host routing results and the restored-model ownership fix are recorded in P1-AS-033/034. |
| P2-AS-021–023 | Implemented; live acceptance blocked | Added distinct Moshi, PersonaPlex, Nemotron VoiceChat and Gemini Live adapters/catalog/config options. Unit fixtures cover endpoints/setup/event normalization; live backend/audio tests are outstanding. |
| P2-AS-024 | Blocked by system Keychain | Normal `code-min.sh` now reuses a stable per-checkout profile and real secret storage. `--fresh-profile` explicitly remains disposable/in-memory. Normal startup blocked in macOS Keychain decryption; computer use cannot operate SecurityAgent. No secure restart pass is claimed. |
| P2-AS-025 | Partial pass | Mouse-selecting `ENTER_OK` in a sidebar transcript and pasting directly into the input produced exactly `ENTER_OK` without a Copy action. Editor transcript selection also triggered the toolbar; independent clipboard, keyboard and empty-selection cases still need verification. |

Implementation details relevant to acceptance:

- Moshi/PersonaPlex use their native `/api/chat` binary protocol and streaming Opus conversion
  through an installed FFmpeg. They require a configured companion ASR binding for user transcripts.
  PersonaPlex voice/persona fields are separate from Nemotron's `/v1/realtime` PCM event schema.
- Gemini Live uses its Bidi WebSocket setup/audio/transcription events. Provider credentials stay
  in the extension host; the workbench receives a single-use loopback WebSocket connection.
- Interruption stops queued audio sources. Stop requests a final companion-ASR flush (bounded wait)
  before closing; completed voice turns are persisted without sending them again to the text model.
- Selection text is copied after selection settles; blank selections do not overwrite the clipboard.
  Add to Chat carries a separate optional comment. Editor input widgets are excluded from code
  selection capture.
- `#` context/tool completion and `@` participant completion come from the upstream chat system;
  Latent adds stable numeric attachment references and their candidate list.

Validation: provider extension compiles; 11 provider/storage/protocol/loopback tests pass, including
invalid bridge token rejection and final-transcript-before-close ordering. Three selection tests
passed earlier in this run. External voice acceptance remains **Blocked**, not Pass.

Protocol references used for the adapters: [Moshi server](https://github.com/kyutai-labs/moshi/blob/main/moshi/moshi/server.py),
[PersonaPlex server](https://github.com/NVIDIA/personaplex/blob/main/moshi/moshi/server.py),
[Nemotron server API](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/api.md),
[Gemini Live WebSocket](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket).

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

### Persistent-profile and Gemini Live follow-up — 2026-09-19

The user resolved the macOS Keychain problem and supplied a Gemini credential. The earlier
Keychain/no-credential blockers are historical; they no longer apply to this run.

| Scenario | Follow-up result | Evidence / limit |
| --- | --- | --- |
| P2-AS-011 | Live first-message pass | Entered `Reply with exactly GLOBAL_THREAD_OK.` in the global window and clicked New Thread; the new editor Thread received exactly that first request and Qwen replied `GLOBAL_THREAD_OK`. |
| P2-AS-010 | Pass for idle geometry | Native screenshot showed the global window at 360 × 80 logical pixels, with no large empty region below the input. Dragging/multiple-display edge cases remain unverified. |
| P2-AS-012/023 | Partial live pass | Configured Google Gemini Live with `gemini-3.8-live`, saved securely, clicked Voice, and observed Listening after the real remote setup handshake. Stop returned to Voice off. After complete Quit/relaunch the same operation succeeded without reentering a key. No actual spoken transcript or audible reply was observed; duplex audio quality, interruption and final transcript persistence are not certified. |
| P2-AS-019 | Pass | Selecting editor response text showed the unpinned SelectionBar. A real mouse click on blank workbench space removed the native overlay. Repeating with Pin kept the overlay visible with its original selected text; Unpin restored ordinary behavior. |
| P2-AS-020 | Pass for tested routes | Code Add to Chat, sidebar transcript → new editor Thread, and editor transcript → new sidebar Thread all completed through the native floating selection window. Source conversations remained intact and the target workbench regained focus. |
| P2-AS-024 | Pass for secure development restart | Default persistent profile saved Gemini securely. A normal app Quit and `scripts/code-min.sh` relaunch restored the endpoint/model/key; Voice reached Listening with no credential entry. Qwen was also saved to the same stable profile and survived Reload Window. |
| P2-AS-025 | Pass for mouse selection in both hosts | Earlier sidebar direct-paste test remains valid. This run selected `EDITOR_COPY_OK` in the editor transcript and pasted directly with Cmd+V; the input contained exactly `EDITOR_COPY_OK` without invoking Copy. Keyboard/empty-selection cases are still not independently certified. |
| P2-AS-021/022 | External backend blocked | Moshi, PersonaPlex and Nemotron adapters compile and pass protocol fixtures. No running local audio server was available, so real audio acceptance remains outstanding. |

Provider keys were entered only into the app's secure credential field and are not included in
specs, screenshots referenced here, or source changes. Current official Gemini model reference:
[Gemini 3.8 Live](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live).
