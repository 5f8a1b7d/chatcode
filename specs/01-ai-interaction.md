# Part 1 — Open-Source VS Code AI Interaction

**Spec ID**: LAT-1 · **Created**: 2026-09-18 · **Status**: Draft for review · **Visibility**: Public

Vocabulary is defined once in [README.md](README.md#shared-glossary) and is not repeated here.

## 1. Scope and succession

Part 1 defines how a user invokes AI from the Workbench, how Drafts and Threads are bound to Tabs,
how Selections and Attachments enter a Thread, how user messages are edited into Branches, how
Threads are found, and how the Managed Runtime keeps working after the Workbench window closes.

Part 1 owns:

- the Floating Composer per editable Tab (evolving the current single-instance
  `src/vs/workbench/contrib/latent/browser/floatingComposer/floatingComposerHost.ts`);
- the Thread model (tree of Turns, Versions, Branches) layered over the upstream chat session;
- Draft state and Attachment Numbers;
- the open-location rule for Side Chat;
- the Sessions search entry with the column view;
- the Managed Runtime (a TypeScript/Node.js port of the relevant Hermes Agent subsystems);
- local Memory with Funes-style conversation recall and opt-in Memory Adapters.

Part 1 does not own the Selection Bar, Provider configuration, or the Floating Window (Part 2),
and does not own any private learning-domain logic (Part 3).

Predecessor material: the current floating composer, the Study Buddy chat participant hand-off
(`src/vs/workbench/contrib/studyBuddySession`), and the upstream chat request-editing feature
(`chat.editRequests`, which truncates history at a checkpoint). Part 1 replaces truncation with
branching and keeps the upstream behaviour reachable through its own setting.

### Public-version constraints

- **P1-FR-001** The public version MUST NOT provide in-app messaging between authenticated users.
  Gateways connect only to external platforms. No Zulip, hosted-room, or member-directory code
  ships in the public tree.
- **P1-FR-002** Context assembly (history selection, compaction, attachment expansion, memory
  recall) MUST run locally: in the Harness, in the Workbench, or in the Managed Runtime. The
  public version MUST NOT depend on a cloud-side context-engineering service.
- **P1-FR-003** All model calls MUST go through Provider Capability Bindings from Part 2 or
  through a local Harness. No module in Part 1 embeds provider credentials or endpoints.

## 2. User flows

### 2.1 Invocation entry points

| Entry point | Where | Result |
| --- | --- | --- |
| Floating Composer | Overlaid at the bottom of every editable Tab | Sends into the Tab's active Thread; expands into an embedded chat |
| **New** button inside the Floating Composer | Composer header lane (`ComposerPluginPlacement` `header`) | Creates a new Thread bound to this Tab and makes it active. The Draft is kept. |
| **+** button at the top of the Editor Area | Fixed control in the editor part title area (`MenuId.EditorTitle`, `navigation` group, `order: -1000`), visible regardless of the active Tab | Creates a new Thread and opens its chat editor in the active Editor Area group; this control does not use the opposite-host rule |
| Selection Actions | Selection Bar (Part 2) on editor, thread, or system selections | `Ask in Side Chat`, `Add to Chat`, optional `Comment` |
| Command Palette | `Latent: New Thread`, `Latent: Open Side Chat`, `Latent: Show All Sessions` (with `Latent: Search Threads` retained as an alias) | Opens the corresponding action; Show All Sessions is discoverable by typing `session` after `>` |
| Floating Window (Part 2) | System-level | `New Thread` opens in the Editor Area |

- **P1-FR-010** Every editable Tab MUST have its own Floating Composer state. Showing the
  composer for the active Tab of a group MUST NOT change any other Tab's Draft or Thread.
- **P1-FR-011** Non-editable Tabs (diff, settings, welcome, image preview, chat editor) show no
  Floating Composer. The `+` button remains available.
- **P1-FR-012** The Floating Composer position, expanded height, and collapsed/expanded state are
  per-Tab view state, persisted in workspace storage under the `TabKey`, separate from the Draft.
- **P1-FR-013** A selected model's label in the Floating Composer MUST have a maximum width
  within the available toolbar space. Overflow is ellipsized, the full provider and model name
  is available through the control's tooltip/accessibility name, and the Send control remains
  visible and clickable at the minimum supported editor width.

### 2.2 Draft and Thread isolation per Tab

- **P1-FR-020** `TabKey` is `{ groupId, typeId, resource }`. Two Tabs for the same resource in
  different groups are different Tabs and hold different Drafts and Threads.
- **P1-FR-021** Moving a Tab to another group re-keys its Draft, Thread binding, and view state to
  the new group; nothing is duplicated or lost. If the target already contains the same resource
  and either tab has a Draft or Thread, block the merge with an explanation and keep both tabs
  and their independent state in their existing groups.
- **P1-FR-022** Closing a Tab keeps its Threads. Its Draft is retained for 7 days (setting
  `latent.drafts.retentionDays`) so that reopening the same resource in the same group restores it.
- **P1-FR-023** A Tab has exactly one **active Thread**. `New` creates and activates a new Thread.
  The Tab's previous Threads stay listed in the composer's thread switcher and in Sessions search.
- **P1-FR-024** Switching the active Tab switches the composer's bound Draft and Thread
  synchronously, before any keystroke can be delivered to the wrong Draft.
- **P1-FR-025** Enter and the visible Send button in both compact and expanded composer states
  MUST submit through the same Draft validation and Thread binding. A click on a compact control
  MUST run that control's action rather than only expanding the host. Clear a Draft only after
  the chat service accepts the request; a rejected or failed submission retains its text,
  Attachments, numbers, and selected model, with a visible error.
- **P1-FR-026** The compact composer, expanded chat, and any Side Chat hand-off are views over
  the same Tab Draft until a request is accepted. Switching Tabs, editor groups, Threads, or
  presentation states MUST neither discard the unsent Draft nor submit it to another Thread.

### 2.3 Selection into Thread context

- **P1-FR-030** When a Selection Action runs, the selected text is copied into the target Draft as
  an Attachment of kind `selection` (text, source URI or application, range, capture time, and
  source Thread/Turn ids when selected in a transcript). The Attachment is immutable: later
  edits to the document or source Thread do not change it.
- **P1-FR-031** `Add to Chat` targets the active Thread of the Tab the selection came from. For a
  system selection (no Tab) it targets the most recently focused editable Tab, otherwise the
  unbound default Thread.
- **P1-FR-032** For a document-editor Selection, `Ask in Side Chat` creates or reuses the source
  Tab's active Thread (creating one if none exists). For a Selection inside a Thread transcript,
  it always creates an independent **new Thread**, leaving the source Thread and its Tab binding
  unchanged. In both cases it adds the immutable Selection Attachment with source location and,
  for a transcript, source Thread and Turn ids. It opens the target in the opposite host under
  P1-FR-040/041, focuses the input, and pre-fills nothing else.
- **P1-FR-033** `Comment` (optional, enabled by setting `latent.selection.comment.enabled`) adds
  the selection Attachment and opens an inline note field whose text is sent as the user message
  together with the Attachment. The comment is stored as a Turn, not as an editor decoration.
- **P1-FR-034** `Add to Chat` also opens a small optional comment input beside the selected
  text (beside the Selection Bar for a system selection). Confirming the comment inserts it into
  the target Draft's message text without sending; skipping or dismissing the input leaves the
  selection Attachment in the Draft. This input is distinct from the optional `Comment` action,
  which sends a Turn. Its value follows the same Draft-preservation rules as P1-FR-026.

### 2.4 Open-location rule for Side Chat

- **P1-FR-040** A Side Chat opened from an origin inside the Secondary Side Bar (the chat view
  pane, Part 2's selection bar on a thread rendered there, or the `+` in that pane) MUST open in
  the Editor Area as a chat editor in the active group. `Ask in Side Chat` on a Thread selection
  creates a new Thread there rather than moving or reusing the source Thread.
- **P1-FR-041** A Side Chat opened from an origin inside the Editor Area (Floating Composer's
  move action, a Selection Action on an editor or Thread selection, a Comment) MUST open in
  the Secondary Side Bar. The chat view container is moved to the auxiliary bar if it is elsewhere,
  and the bar is revealed. `Ask in Side Chat` on a Thread selection creates a new Thread there;
  the Floating Composer move action continues to move the existing Thread. This generalises the
  existing `_openInSideChat` behaviour.

| Origin | Opens in |
| --- | --- |
| Secondary Side Bar | Editor Area |
| Editor Area `+` (new Thread) | Editor Area, active group |
| Other Editor Area Side Chat actions | Secondary Side Bar |
| Floating Window (Part 2) | Editor Area |
| System selection (Part 2), Command Palette | Secondary Side Bar |

- **P1-FR-042** If the requested host cannot be opened (auxiliary bar disabled by policy, no
  editor group), the opener falls back to the other host and shows a non-modal notice.
- **P1-FR-043** The Editor Area title `+` uses `openNew` with an explicit Editor Area target,
  including on a non-editable Welcome Tab. The Secondary Side Bar `+` and actions originating
  inside its transcript continue to follow P1-FR-040.

### 2.5 Attachment Numbers and `#<number>:<MIME>` references

- **P1-FR-050** Each Attachment receives the next integer from the Draft's counter at the moment it
  is added, starting at `1`. The number is displayed before the attachment name as `<number>:<name>`
  in the context-management area, in addition order.
- **P1-FR-051** Numbers are never reused within the same Draft. Removing an Attachment leaves a
  gap; re-adding the same item yields a new number. The counter is part of the persisted Draft.
- **P1-FR-052** The message body references an Attachment as `#<number>:<MIME>`. When the message is
  sent, every valid reference is rewritten for the model as `[#<number>: <name>]` and the
  Attachment is sent in its normal position; the user-visible Turn keeps the original reference
  text rendered as a link to the Attachment.
- **P1-FR-053** Before sending, the Draft is validated. A reference is **invalid** when its number
  was never assigned in this Draft, and **stale** when it was assigned to an Attachment that was
  removed. Invalid and stale references MUST be surfaced as inline diagnostics in the input editor
  (squiggle, hover text, and a list under the input) and the send action MUST be blocked until
  the user resolves them. This guard applies to Enter, button click, compact composer, expanded
  chat, and queued/steered requests. Quick fixes: *Remove reference*, *Re-add attachment* (stale
  only); their controls remain actionable when the compact composer expands.
- **P1-FR-054** Attachment Numbers are frozen into the sent Turn. Editing that Turn later (2.6)
  starts from the same numbered Attachments; the Draft counter of the edit continues from the
  Turn's highest number.
- **P1-FR-055** Numbers are Draft-local. Two Tabs may both have a `#1`. A Turn rendered in a Thread
  shows its own numbering.
- **P1-FR-056** Typing `#` in a Floating Composer with context items opens a completion list for
  its live numbered Attachments, with number, name, and source. Selecting a candidate inserts
  `#<number>:<MIME>`; removed Attachments are excluded. The list supports arrow keys, Enter,
  Escape, and mouse selection like the Secondary Side Bar chat input. Numeric
  `#<number>:<MIME>` is Latent's Draft-local
  Attachment syntax; upstream named `#` context/tool mentions and `@` chat participants retain
  their existing meanings and completions. Neither leader silently changes the active Thread.

Syntax provenance: [VS Code chat documentation](https://code.visualstudio.com/docs/chat/copilot-chat-context)
defines `#` for context/tools and `@` for chat participants. This fork's inherited
`chatParserTypes.ts` declares those two leaders, and `chatInputCompletions.ts` accepts both as
completion triggers for some context and tool providers. Consequently, overlapping suggestions
are inherited chat behavior; Latent owns only the additional numeric `#<number>:<MIME>` Attachment
reference and its validation. The Floating Composer should reuse the upstream candidate sources
without treating `@` as an Attachment Number.

### 2.6 Editing a user message creates a Branch

- **P1-FR-060** Every user Turn exposes an **Edit** action. Editing opens the Turn's text and
  Attachments in the composer in edit mode.
- **P1-FR-061** Submitting the edit creates a new Version: a sibling user Turn under the same
  parent, with a fresh assistant response requested for it. The original user Turn, its response,
  and every later Turn on the original Branch are preserved unchanged.
- **P1-FR-062** The action bar of a user Turn that has more than one Version shows `<-` and `->`
  and a `i / n` counter. `<-`/`->` switch the active Branch to the previous/next Version and to the
  most recent leaf under that Version. The controls remain visible on every sibling Version,
  including the edited Version's own Turn. Switching never sends a request.
- **P1-FR-063** Cancelling an edit leaves the Thread unchanged.
- **P1-FR-064** Editing while a request is in progress on the current Branch first cancels that
  request (with confirmation, mirroring upstream `chat.cancelEditing.confirm`).
- **P1-FR-065** The upstream truncating behaviour stays available under
  `latent.threads.editMode: "branch" | "upstream"` (default `branch`), which hides the upstream
  `chat.editRequests` behaviour through its own switch instead of removing it.

### 2.7 Sessions as a top-level search entry

- **P1-FR-070** The existing agent sessions list is exposed as a **Sessions** view inside the
  Search view container (`workbench.view.search`) as its first view, and as the quick access prefix
  `session ` (`thread ` remains an alias). The view's search box filters Threads by title, Turn
  text, Tab resource, and Bot.
- **P1-FR-071** With an empty query the view lists **all** Threads (workbench Threads, Harness
  sessions, and Managed Runtime Bot sessions), most recent first, grouped by day.
- **P1-FR-072** The view offers a visible **List / Columns** control. List mode shows every
  matching session. Finder-style Columns mode shows column 1 Threads, column 2 Branches of the
  selected Thread (label, last activity, Turn count), column 3 Turns of the selected Branch, and
  a preview pane showing the selected Turn. Keyboard: `→` descends, `←` ascends, `Enter` opens
  the selected Thread and Branch as Side Chat. Switching modes preserves the query and selection.
- **P1-FR-073** The list and column view are read-only projections of `IThreadService`; opening a
  Thread from the view never creates a new session.
- **P1-FR-074** `Latent: Show All Sessions` is a Command Palette action discoverable when the
  user types `>sesi`. It opens the Sessions view with an empty query, focuses the session list,
  and shows all available workbench, Harness, and Bot sessions. Keep the existing
  `latent.thread.search` action as a compatibility alias for this destination.
- **P1-FR-075** The List / Columns choice is available in the Sessions view toolbar and is
  remembered per workspace. Opening Show All Sessions defaults to the last chosen mode; a fresh
  workspace starts in List mode so all sessions are immediately visible.

### 2.8 Managed Runtime

- **P1-FR-080** The Managed Runtime is a Node.js process owned by the application, started by the
  Electron main process, and reachable over a local JSON-RPC socket (Unix domain socket or Windows
  named pipe) under the user-data directory.
- **P1-FR-081** After the last Workbench window is closed, and after the application quits, the
  Managed Runtime MUST continue to receive Gateway messages and execute Scheduled Jobs while
  `latent.runtime.background.enabled` is `true` (default `false`; the first Gateway configuration
  offers to enable it). Background operation is implemented through the platform's user-level
  service facility: launchd agent on macOS, systemd user unit on Linux, Task Scheduler logon task
  on Windows. The application installs, updates, and removes the registration.
- **P1-FR-082** The Managed Runtime hosts these subsystems, ported from Hermes Agent:
  **Gateways** and their configuration; **Bots**; **Memory**; **Runtime Capabilities**;
  **Artifacts**; **Scheduled Jobs**. Section 3.3 maps each to its Hermes origin.
- **P1-FR-083** Bots run with a local Harness or with a Provider Capability Binding, selected per
  Bot. A Bot's Tool Authorization Scope is explicit and enforced by the runtime before any tool
  call; anything outside the scope raises an approval request that is delivered to the Workbench
  (when open) and to the originating Gateway (as an approval prompt) and times out as *denied*.
- **P1-FR-084** The Workbench shows runtime state (connected, background enabled, gateway health,
  next scheduled runs) in a **Runtime** status bar item and a **Runtime** view in the Explorer's
  Bots tab. Runtime sessions appear in Sessions search.
- **P1-FR-085** A Bot may name other Bots as hand-off targets (`handoffTargets`). The built-in
  `handoff` tool runs a listed target with the request and returns its answer; the hand-off and
  the answer are recorded in both sessions. The runtime tells the model its targets, refuses
  targets that are not listed, and refuses a target that is already running, so hand-offs cannot
  cycle. Like every tool, `handoff` is subject to the Tool Authorization Scope.
- **P1-FR-086** Extensions contribute default Bots as **Bot presets**
  (`latent.runtime.api.registerBotPresets(owner, bots)`). A preset creates its Bot once, unless a
  Bot with that id exists; afterwards the Bot belongs to the user, and edits or deletions are kept
  when the extension registers its presets again. *Restore Default Bots* resets the Bots the user
  picks to their presets, recreating deleted ones. A preset id belongs to one owner.

### 2.9 Memory

- **P1-FR-090** Memory is persisted locally under the user-data directory. The Memory Store holds
  (a) memory notes and a user profile with the Hermes `memory_tool` write model (add, replace,
  remove, with a write gate that stages destructive changes for confirmation), and (b) the Recall
  Index over Threads, Harness sessions, and runtime sessions.
- **P1-FR-091** Recall follows the Funes pipeline: hybrid retrieval (vector + BM25 fused by
  reciprocal rank), cross-encoder rerank when a local reranker is available, recency reweight with
  a configurable half-life, and neighbour expansion. Results carry provenance (Thread id, Branch
  id, Turn `seq`, timestamp, harness, workdir) and the stable *agent format* output contract.
- **P1-FR-092** The Recall Index is disposable: deleting it loses nothing; it can be rebuilt from
  Threads and session stores. Memory notes and the profile are the source of record and are
  exported as plain files (`memory/MEMORY.md`, `memory/USER.md`, `memory/entries/*.md`).
- **P1-FR-093** Recall results are never injected invisibly. A Turn that used recall shows the
  recalled passages as numbered context items the user can open and remove.
- **P1-FR-094** External memory systems (Mem0 and others) are available only as Memory Adapters
  that the user enables explicitly per adapter (`latent.memory.adapters.<id>.enabled`, default
  `false`). An adapter can mirror or query, never replace, the local store.
- **P1-FR-095** An enabled Memory Adapter that exposes its remote copy can be compared with local
  memory without changing either: each entry is `same`, `localOnly`, `remoteOnly`, or `conflict`
  (a remote entry similar enough to an unmatched local entry). *Review Memory Adapter Copy* walks
  the differing entries, shows each conflict as a diff, and applies only the choices the user
  makes: *keep local* writes the local version to that adapter, *take the adapter's version*
  writes it to local memory (and mirrors it to the enabled adapters).

## 3. Module boundaries

```text
Workbench (renderer)
├─ contrib/latent/browser/threads/          IThreadService, branch tree, ChatModel materialisation
├─ contrib/latent/browser/drafts/           ITabDraftService, attachment numbers, reference validation
├─ contrib/latent/browser/floatingComposer/ FloatingComposerHost (one per editable Tab), New button
├─ contrib/latent/browser/sideChat/         ISideChatOpener (open-location rule)
├─ contrib/latent/browser/sessionsSearch/   Sessions view in Search container, column view, quick access
├─ contrib/latent/browser/runtime/          Runtime status, Bots tab view, approval UI
└─ contrib/latent/electron-browser/latent.contribution.ts   single registration seam (exists)

Electron main
├─ code/electron-main/latent.contribution.ts   registration seam (exists)
└─ platform/latentRuntime/electron-main/       RuntimeSupervisor: spawn, health, service registration

Managed Runtime (Node.js, separate process)  src/vs/latentRuntime/
├─ rpc/          JSON-RPC server, auth token, schema-validated messages
├─ gateway/      platform registry, adapters, delivery ledger, pairing
├─ bots/         bot registry, run loop, tool authorization scope, approvals
├─ memory/       memory store, recall index, adapters
├─ capabilities/ skill packages (agentskills.io), toolsets, MCP client
├─ artifacts/    artifact store and delivery
└─ jobs/         schedule parsing, ticker, execution ledger, delivery queue
```

Layering rules:

- **P1-FR-100** `src/vs/latentRuntime/` imports only from `vs/base` and `vs/platform/*/common`.
  It never imports `vs/workbench`, `vs/editor`, or Electron.
- **P1-FR-101** The Workbench talks to the Managed Runtime only through
  `IManagedRuntimeService` (workbench) → main-process channel → RPC socket. Renderer code never
  opens the socket directly.
- **P1-FR-102** `IThreadService` is the single owner of the Turn tree. The upstream `ChatModel`
  is a projection of the active Branch: switching Branch rebuilds the projection through
  `adoptRequest` / `removeRequest` (reason `Adoption`), never by mutating stored Turns.
- **P1-FR-103** Upstream files touched: `chatInputPart.ts` (existing plugin hooks) and one
  registration line in `workbench.desktop.main.ts` (existing). No new upstream edits are
  permitted for the composer, Sessions view, or Branch rendering; the renderer extension is done
  through `IChatListRenderer` hooks contributed from the fork folder.

### 3.3 Hermes subsystem mapping

| Managed Runtime module | Hermes origin (v2026.9.14) | Port notes |
| --- | --- | --- |
| `gateway/` platform registry, `BasePlatformAdapter` contract (`connect`, `disconnect`, `send`, `send_draft`, `edit_message`, `delete_message`, `send_typing`, exec-approval prompts, access policy) | `gateway/platform_registry.py`, `gateway/platforms/base.py`, `gateway/platforms/{signal,whatsapp_cloud,webhook,api_server}.py`, `gateway/delivery.py`, `gateway/delivery_ledger.py`, `gateway/pairing.py` | Same adapter surface in TypeScript. First wave: Telegram, Discord, Slack, webhook. Second wave: WhatsApp Cloud, Signal. Hosted rooms are excluded (P1-FR-001). |
| `gateway/config` | `gateway/config.py`, `config_loader.py`, `config_env.py` | YAML/JSON config under user-data `runtime/gateways.json`; secrets in the runtime secret file (3.4) |
| `bots/` | `agent/`, `gateway/profile_routing.py`, `tools/approval*.py`, `toolsets.py` | Bot = profile + toolset + authorization scope. Approval floors reimplemented as `IToolAuthorizationScope`. |
| `memory/` store | `tools/memory_tool.py`, `tools/memory_tool_store.py` | Same targets (`memory`, `user`), same write gate semantics |
| `memory/` recall | Hermes `hermes_state_fts.py` session search, extended with Funes `docs/recall.md` pipeline | Funes contract reimplemented in TypeScript over SQLite FTS5 + local embeddings; optional adapter to a user-installed `funes` binary |
| `capabilities/` | `skills/`, `tools/skills_tool.py`, `tools/skill_manager_tool.py`, `tools/mcp_tool*.py` | agentskills.io directory layout; MCP client reused from upstream `vs/platform/mcp` |
| `artifacts/` | `tools/tool_result_storage.py`, `gateway/browser_control_artifacts.py`, delivery of files in `gateway/platforms/base.py` (`send_image`, `send_multiple_images`) | Artifact store with provenance; delivered to Gateways or shown in the Workbench |
| `jobs/` | `cron/jobs.py`, `cron/scheduler*.py`, `cron/delivery_queue.py`, `cron/executions.py`, `cron/incidents.py` | `parse_schedule` grammar (cron, `every 30m`, one-shot `at`) and the heartbeat/catch-up semantics retained |

### 3.4 Runtime storage

| Data | Location (under user-data dir) | Format |
| --- | --- | --- |
| Threads, Turns, Branches | `latent/threads.db` | SQLite; `ISerializableChatData` per Branch materialisation stays in upstream chat storage |
| Drafts, Attachment counters | workspace storage, key `latent.draft.<TabKey hash>` | JSON |
| Runtime sessions, jobs, artifacts index, gateway ledgers | `latent/runtime/runtime.db` | SQLite |
| Memory notes, profile | `latent/memory/*.md` | Markdown (source of record) |
| Recall Index | `latent/memory/index/` | SQLite FTS5 + vector table; disposable |
| Gateway and Bot config | `latent/runtime/gateways.json`, `bots.json` | JSON, schema-validated |
| Runtime secrets | `latent/runtime/secrets.enc` | Encrypted with a key held in the OS keychain (`keyring`-class native module, permissive license). The runtime must decrypt without the Workbench running. |

## 4. Extension interfaces

All interfaces are fork-owned and live under `src/vs/workbench/contrib/latent/common/` or
`src/vs/latentRuntime/common/`. Types shown are normative; names may gain `readonly` and
`Event` plumbing.

```ts
/** Identity of an editable Tab. */
export interface ITabKey {
	readonly groupId: number;
	readonly typeId: string;
	readonly resource: URI;
}

export interface IDraftAttachment {
	readonly number: number;                 // stable within the Draft
	readonly entry: IChatRequestVariableEntry; // upstream attachment payload
	readonly addedAt: number;
	readonly removedAt?: number;             // set instead of deleting, so stale refs can be explained
}

export interface IDraft {
	readonly tabKey: ITabKey;
	readonly text: string;
	readonly attachments: readonly IDraftAttachment[];
	readonly nextAttachmentNumber: number;
	readonly updatedAt: number;
}

export type ReferenceDiagnosticKind = 'invalid' | 'stale';

export interface IReferenceDiagnostic {
	readonly kind: ReferenceDiagnosticKind;
	readonly number: number;
	readonly range: IRange;                  // in the input editor
	readonly quickFixes: readonly ('removeReference' | 'reAddAttachment')[];
}

export interface ITabDraftService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeDraft: Event<ITabKey>;
	getDraft(tabKey: ITabKey): IDraft;
	setText(tabKey: ITabKey, text: string): void;
	addAttachment(tabKey: ITabKey, entry: IChatRequestVariableEntry): number;
	removeAttachment(tabKey: ITabKey, number: number): void;
	validateReferences(tabKey: ITabKey): readonly IReferenceDiagnostic[];
	/** Rewrites #n references for the model and freezes numbers into the outgoing request. */
	prepareForSend(tabKey: ITabKey): { text: string; attachments: readonly IDraftAttachment[] };
	rekey(from: ITabKey, to: ITabKey): void;
}

export type TurnId = string;

export interface IThreadTurn {
	readonly id: TurnId;
	readonly parentId: TurnId | undefined;   // undefined for the root user Turn
	readonly role: 'user' | 'assistant';
	readonly seq: number;                    // dense per-Branch counter used by recall provenance
	readonly createdAt: number;
	readonly text: string;
	readonly attachments: readonly IDraftAttachment[]; // frozen numbers
	readonly upstreamRequestId?: string;      // ChatRequestModel id when materialised
}

export interface IThreadBranch {
	readonly id: string;
	readonly leafTurnId: TurnId;
	readonly label: string;
	readonly lastActivity: number;
}

export interface IThread {
	readonly id: string;
	readonly title: string;
	readonly tabKey?: ITabKey;
	readonly origin: 'workbench' | 'harness' | 'runtime';
	readonly activeBranchId: string;
	readonly sessionResource: URI;           // upstream session used for the active Branch projection
}

export interface IThreadService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeThreads: Event<void>;
	readonly onDidChangeActiveBranch: Event<{ threadId: string; branchId: string }>;
	createThread(options: { tabKey?: ITabKey; title?: string }): Promise<IThread>;
	listThreads(filter?: { tabKey?: ITabKey; query?: string }): Promise<readonly IThread[]>;
	getTurns(threadId: string, branchId?: string): Promise<readonly IThreadTurn[]>;
	listBranches(threadId: string): Promise<readonly IThreadBranch[]>;
	listVersions(threadId: string, turnId: TurnId): Promise<readonly TurnId[]>;
	/** Creates a sibling Version and a new Branch; returns the new Branch. Never mutates existing Turns. */
	editTurn(threadId: string, turnId: TurnId, draft: { text: string; attachments: readonly IDraftAttachment[] }): Promise<IThreadBranch>;
	switchVersion(threadId: string, turnId: TurnId, direction: 'previous' | 'next'): Promise<IThreadBranch>;
	setActiveBranch(threadId: string, branchId: string): Promise<void>;
	setActiveThread(tabKey: ITabKey, threadId: string): void;
	getActiveThread(tabKey: ITabKey): IThread | undefined;
}

export type SideChatOrigin = 'editorArea' | 'secondarySideBar' | 'floatingWindow' | 'systemSelection' | 'commandPalette';

export interface ISideChatOpener {
	readonly _serviceBrand: undefined;
	open(threadId: string, origin: SideChatOrigin, options?: { attachments?: readonly IChatRequestVariableEntry[]; focusInput?: boolean }): Promise<IChatWidget>;
	resolveHost(origin: SideChatOrigin): 'editorArea' | 'secondarySideBar';
}

/** Contributed by fork code; other contributions may add Sessions search sources. */
export interface ISessionsSearchSource {
	readonly id: string;
	search(query: string, token: CancellationToken): Promise<readonly IThread[]>;
}
```

Managed Runtime RPC (JSON-RPC 2.0, versioned `latent.runtime/1`):

```ts
export interface IManagedRuntimeService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<IRuntimeState>;
	readonly onDidRequestApproval: Event<IRuntimeApprovalRequest>;
	getState(): Promise<IRuntimeState>;                  // { connected, backgroundEnabled, version, gateways: IGatewayHealth[] }
	setBackgroundEnabled(enabled: boolean): Promise<void>;
	// gateways
	listGateways(): Promise<readonly IGatewayConfig[]>;
	upsertGateway(config: IGatewayConfig, secret?: string): Promise<void>;
	removeGateway(id: string): Promise<void>;
	pair(gatewayId: string): Promise<IPairingCode>;      // Hermes pairing model for DM authorization
	// bots
	listBots(): Promise<readonly IBotConfig[]>;
	upsertBot(config: IBotConfig): Promise<void>;
	runBot(botId: string, input: IBotInput): Promise<IRuntimeSessionRef>;
	respondToApproval(requestId: string, decision: 'allow' | 'deny' | 'allowScope'): Promise<void>;
	// memory
	recall(query: string, options?: IRecallOptions): Promise<readonly IRecallHit[]>;
	memoryWrite(op: IMemoryWriteOp): Promise<IMemoryWriteResult>; // may return { staged: true } under the write gate
	listMemoryAdapters(): Promise<readonly IMemoryAdapterState[]>;
	setMemoryAdapterEnabled(id: string, enabled: boolean): Promise<void>;
	// capabilities
	listCapabilities(): Promise<readonly IRuntimeCapability[]>;
	installCapability(source: ICapabilitySource): Promise<IRuntimeCapability>;
	// artifacts
	listArtifacts(filter?: IArtifactFilter): Promise<readonly IArtifact[]>;
	// jobs
	listJobs(): Promise<readonly IScheduledJob[]>;
	upsertJob(job: IScheduledJob): Promise<void>;
	runJobNow(id: string): Promise<IRuntimeSessionRef>;
}

export interface IBotConfig {
	readonly id: string;
	readonly name: string;
	readonly systemPrompt: string;
	readonly execution: { kind: 'harness'; harness: 'copilot' | 'codex' | 'claude' } | { kind: 'provider'; capability: 'text'; preferredModel?: string };
	readonly toolAuthorizationScope: IToolAuthorizationScope;
	readonly capabilities: readonly string[];            // Runtime Capability ids
	readonly gateways: readonly { gatewayId: string; chatIds?: readonly string[] }[];
}

export interface IToolAuthorizationScope {
	readonly allowTools: readonly string[];              // exact tool ids or globs
	readonly allowPaths: readonly string[];              // workspace-relative globs for file tools
	readonly allowNetwork: readonly string[];            // host allow-list
	readonly autoApprove: boolean;                       // within scope only
}

export interface IRecallOptions { k?: number; candidates?: number; halfLifeDays?: number; neighbors?: number; type?: 'text' | 'thinking' | 'tool_use' | 'tool_result'; harness?: string }
export interface IRecallHit { threadId: string; branchId: string; seq: number; timestamp: number; score: number; text: string; neighbors: readonly { seq: number; role: string; preview: string }[]; agentFormat: string }
```

Contribution points added by Part 1 (all under the `latent` namespace):

| Point | Purpose |
| --- | --- |
| `latent.sessionsSearchSources` (registry) | Additional Thread sources for Sessions search |
| `latent.composerPlugins` (registry, existing `IComposerPlugin`) | Header/leading/trailing composer actions; `New` is registered here |
| `latent.memoryAdapters` (registry) | Memory Adapters; each declares id, display name, and that it defaults to disabled |
| `latent.gatewayPlatforms` (runtime registry) | Additional Gateway adapters implementing the platform contract |
| `latent.botTools` (runtime registry) | Additional tools with a declared scope key |
| `latent.runtime.api.registerBotPresets` (runtime API) | Default Bots contributed by an extension (P1-FR-086) |

## 5. Failure states

| Situation | Behaviour |
| --- | --- |
| Draft storage unavailable or corrupt | Composer opens with an empty Draft, a warning is logged, and the corrupt blob is moved to `latent.draft.<key>.corrupt` for recovery. Sending is not blocked. |
| Attachment source no longer exists (file deleted) | Attachment pill shows a broken-link state; `#n` references to it are reported as `stale` until removed or re-added. |
| Invalid or stale `#n` at send | Send blocked; diagnostics shown (P1-FR-053). Never silently stripped. |
| Edit submitted while the request on the Branch is running | Cancel with confirmation, then branch. If cancellation fails, the edit is not applied and the user is told. |
| Branch projection fails (upstream ChatModel rejects adoption) | The active Branch pointer is not changed; the previous projection remains; error notification with *Retry*. Stored Turns are never touched. |
| Side Chat host cannot open | Fallback host (P1-FR-042) with notice. |
| Sessions search source throws | That source is omitted for the query, a warning is shown in the view footer, others still render. |
| Managed Runtime not running | Status bar shows *Runtime stopped*; runtime-dependent actions are disabled with a tooltip; Threads and Drafts keep working. |
| Runtime socket auth mismatch (stale token) | Workbench refuses the connection, restarts the runtime once, then reports. |
| Background registration denied by OS (launchd/systemd/Task Scheduler) | `background.enabled` reverts to `false`; a notification explains the missing permission; the runtime still works while the app is open. |
| Gateway credential invalid / platform unreachable | Gateway marked degraded with the last error; deliveries queued in the delivery ledger and retried with backoff; no message is dropped silently. |
| Bot tool outside scope | Approval request delivered to Workbench and Gateway; times out to *denied*; the Bot receives a structured denial and continues. |
| Job fires while a previous run is still active | Skipped occurrence recorded (Hermes lateness classification); no overlap unless the job declares `allowOverlap`. |
| Recall index corrupt | Index dropped and rebuilt in the background; recall returns `no results` with a rebuilding flag meanwhile. |
| Memory Adapter enabled but unreachable | Local store remains authoritative; adapter marked degraded; no write is lost because writes are journaled locally first. |
| Missing Provider Capability (Part 2) | Runtime surfaces the Part 2 guidance action; Bot run fails fast with `capabilityUnavailable`. |

## 6. Migration strategy

1. **Floating Composer → per-Tab instances.** Keep `FloatingComposerHost` as the rendering unit.
   Replace the singleton `FloatingComposerService` binding (last focused widget) with a
   `TabComposerCoordinator` that creates one host per editor group, binds it to the group's active
   editable Tab, and swaps the `ComposerModel` draft on `onDidActiveEditorChange`. The existing
   `_openInSideChat` becomes `ISideChatOpener.open(threadId, 'editorArea')`.
2. **Drafts.** Today the draft lives in the bound chat widget's input editor. Introduce
   `ITabDraftService` as the owner; the widget input becomes a view of the Draft. Existing
   unsaved input in a widget is captured into the Draft of the Tab that widget was bound to on first
   run; if no Tab can be resolved it is captured into a `recovered` Draft listed in Sessions search.
3. **Threads over sessions.** Existing upstream chat sessions are imported as single-Branch
   Threads on first launch (idempotent, keyed by session resource). No session file is rewritten;
   `threads.db` only adds the tree. Rollback is deleting `threads.db`.
4. **Editing.** `latent.threads.editMode` defaults to `branch`. Upstream truncating edit remains
   available with `upstream`.
5. **Sessions view.** The existing agent sessions viewer classes are reused as the column-1
   renderer; the Search container view is registered in fork code; the existing location of the
   sessions control stays registered and is hidden by `latent.sessions.showLegacyEntry: false`.
6. **Study Buddy hand-off.** The legacy `latentnote.studyBuddy.openAgentSession` command is
   owned by the private derivative's workbench overlay. The public build contains the generic
   Thread and harness-session integration; it does not register the research participant's command.
7. **Managed Runtime.** Ships disabled (`latent.runtime.enabled: false`) in the first release
   train; enabling it starts the process on demand. Background mode is opt-in per P1-FR-081.
   Existing `~/.studybuddy/extension-memories.json` records (Study Buddy service memories) are
   imported into `latent/memory/entries/` once, with the source path recorded in each entry.
8. **Memory.** Local store first; adapters are separate modules that can be shipped later without
   schema changes.

Rollback for every step is a setting flip plus deletion of the fork-owned data file; upstream data
is never rewritten.

## 7. Acceptance scenarios

Harness legend: **U** unit test (`scripts/test.sh --grep`), **P** Playwright through the `launch`
skill, **S** smoke/integration, **M** scripted manual run.

| ID | Scenario | Harness |
| --- | --- | --- |
| P1-AS-001 | **Draft isolation across tabs.** Given `a.md` and `b.md` are open in the same group, When the user types `hello #1` in `a.md`'s composer, adds a file attachment there, then switches to `b.md`, Then `b.md`'s composer is empty with counter `1`, and switching back shows `hello #1` with attachment `#1`. | P |
| P1-AS-002 | **Same resource, two groups.** Given `a.md` open in group 1 and group 2, When a Draft is typed in group 1, Then group 2's Draft is unaffected; When a move would merge it with the already-open copy in group 2 and either copy has a Draft or Thread, Then the move is blocked with an explanation and both groups retain their independent state; moving to a group without that resource preserves the moved tab's state. | P |
| P1-AS-003 | **Thread isolation.** Given Threads T1 (tab A) and T2 (tab B), When a message is sent from tab A, Then only T1 gains a Turn and tab B's active Thread is still T2. | P |
| P1-AS-004 | **New button.** Given tab A with active Thread T1 and a non-empty Draft, When `New` is clicked, Then a new Thread T3 is active for tab A, the Draft text and attachments are unchanged, and T1 appears in the thread switcher and Sessions search. | P |
| P1-AS-005 | **Editor Area + button.** Given any active editor (including a non-editable Welcome tab), When `+` in the editor title area is clicked, Then a new Thread opens as a chat editor in the active Editor Area group with focus in its input; the Secondary Side Bar does not replace it. | P |
| P1-AS-006 | **Selection → Ask in Side Chat.** Given text selected in `a.md`, When `Ask in Side Chat` runs, Then the Secondary Side Bar chat shows a `selection` attachment `#n` whose text equals the selection and whose source is `a.md` with the range, and the input is focused. | P |
| P1-AS-007 | **Add to Chat.** Given a selection in `a.md` and a Draft with counter 3, When `Add to Chat` runs, Then the Draft has attachment `#3` with the selection and counter becomes 4. | P |
| P1-AS-008 | **Open-location rule, from side bar.** Given a Side Chat in the Secondary Side Bar, When the user triggers *Open Side Chat* from that pane, Then a chat editor for the same Thread opens in the active editor group. Transcript selection uses the new-Thread rule in P1-AS-034. | P |
| P1-AS-009 | **Open-location rule, from editor area.** Given the floating composer of `a.md`, When its move action runs, Then the Thread opens in the Secondary Side Bar and the floating host is collapsed and unbound. | P |
| P1-AS-010 | **Stable numbering.** Given attachments `#1`, `#2`, `#3`, When `#2` is removed and a new file is added, Then the new file is `#4` and the pills read `#1 #3 #4`. | U |
| P1-AS-011 | **Invalid reference blocked in every host.** Given a Draft `see #7` with attachments `#1..#3`, When Enter and Send are tried in both compact and expanded states, Then no request is sent, a diagnostic `invalid` at `#7` is shown, and *Remove reference* clears it and enables Send. | U + P |
| P1-AS-012 | **Stale reference blocked.** Given `see #2` and `#2` removed, When Send is pressed, Then diagnostic `stale` is shown with an actionable *Re-add attachment* even after the host expands; after re-adding, the reference is rewritten to the new number and Send proceeds. | U + P |
| P1-AS-013 | **Model-facing rewrite.** Given `compare #1 and #3`, When sent, Then the outgoing request text is `compare [#1: a.md] and [#3: selection]` and the rendered Turn still shows `#1`/`#3` as links. | U |
| P1-AS-014 | **Edit creates a Branch.** Given Thread with Turns U1→A1→U2→A2, When U1 is edited to U1′ and submitted, Then the tree has U1 and U1′ as siblings, U1's subtree (A1, U2, A2) is intact, the active Branch is U1′→A1′, and `listBranches` returns 2. | U |
| P1-AS-015 | **Version switching.** Given the tree from P1-AS-014, When `<-` is pressed on U1′, Then the projection shows U1→A1→U2→A2 and the counter reads `1 / 2`; `->` returns to `2 / 2`; no request is sent in either direction. | P |
| P1-AS-016 | **Edit during running request.** Given a request in progress on the active Branch, When an earlier Turn is edited and the confirmation is accepted, Then the running request is cancelled before the new Branch is created; declining leaves everything unchanged. | P |
| P1-AS-017 | **Show all Sessions.** Given 3 workbench Threads, 1 Harness session, 1 runtime Bot session, When `Latent: Show All Sessions` opens the Sessions view with an empty query, Then all 5 are listed most-recent-first grouped by day. | P |
| P1-AS-018 | **Finder column view.** Given the tree from P1-AS-014, When Columns mode is selected and its Thread is selected, Then column 2 lists 2 Branches, selecting one lists its Turns in column 3, and `Enter` opens that Thread with that Branch active as Side Chat. | P |
| P1-AS-019 | **Runtime survives window close.** Given background mode enabled, a Telegram (or webhook) Gateway paired, and a job `every 1m`, When all Workbench windows are closed and the app quits, Then a message sent to the Gateway within 2 minutes receives a Bot reply, and the job's execution ledger shows a run after the quit timestamp. | S (webhook gateway with a local receiver) + M (Telegram) |
| P1-AS-020 | **Runtime reconnect.** Given the runtime kept running after quit, When the app is launched again, Then the Workbench connects to the existing process (no second instance), and Sessions search lists the Bot session created while the window was closed. | S |
| P1-AS-021 | **Scope enforcement.** Given a Bot whose scope allows `read_file` under `docs/**` only, When the Bot attempts `write_file docs/x.md`, Then an approval request is raised, times out to denied after `latent.runtime.approvalTimeoutSeconds`, and the Bot output reports the denial. | U |
| P1-AS-022 | **Local recall.** Given two prior Threads mentioning "streaming parser", When `recall("why did we switch off the streaming parser")` runs offline, Then hits carry Thread id, Branch id, `seq`, timestamp, and the `→ get` drill-down line, and no network request is made. | U |
| P1-AS-023 | **Recall is visible.** Given recall contributed 2 passages to a Turn, When the Turn is rendered, Then both passages are shown as context items that can be opened and removed before resend. | P |
| P1-AS-024 | **Adapters opt-in.** Given a fresh profile, When `listMemoryAdapters` runs, Then every adapter reports `enabled: false`; enabling Mem0 requires the explicit setting and a credential from Part 2. | U |
| P1-AS-025 | **No in-app user messaging.** Given the public build, When the command list, contribution points, and runtime RPC methods are enumerated, Then none matches `directMessage`, `groupChat`, `hostedRoom`, or `memberDirectory`. | U (static assertion over registries) |
| P1-AS-026 | **Local context assembly.** Given network access blocked except the configured model endpoint, When a Turn with 3 attachments and recall is sent, Then the request succeeds and the only outbound host is the Provider endpoint. | S |
| P1-AS-027 | **Optional comment on Add to Chat.** Given selected editor text, When *Add to Chat* runs, Then a comment input appears beside the selection and the immutable selection Attachment is added to that Tab's Draft; entering a comment adds it to the Draft without sending, while skipping keeps the Attachment and adds no comment. | P |
| P1-AS-028 | **Floating Composer sends.** Given a valid non-empty Draft in a Tab, When Enter is pressed or Send is clicked in compact and expanded states, Then exactly one request is accepted into that Tab's active Thread and the Draft clears only after acceptance; an induced provider failure keeps the Draft and shows an error. | P + S |
| P1-AS-029 | **Draft survives switching.** Given text, a selection Attachment, and a selected model in `a.md`, When the user switches to `b.md`, changes editor groups, expands/collapses the composer, and returns, Then `a.md` still has the same unsent Draft and `b.md` has its own Draft. | P |
| P1-AS-030 | **Context completions.** Given two live numbered Attachments and one removed Attachment, When `#` is typed in the Floating Composer, Then the two live items appear with numbers and source, the removed item does not, and selecting one inserts its numeric reference; native named `#` and `@` completions remain available. | P |
| P1-AS-031 | **Selected-model width.** Given a long provider URL or model name and a narrow editor group, When the composer is shown, Then the model label is ellipsized within a maximum width, its full name is accessible, and Send is visible and clickable. | P |
| P1-AS-032 | **Command Palette Sessions entry and mode toggle.** Given several sessions, When `>sesi` is typed in the Command Palette, Then `Latent: Show All Sessions` is offered; running it shows every session in List mode on a fresh workspace, and switching to Columns preserves the query and selection, shows Branches and Turns, and is remembered on reopen. | P |
| P1-AS-033 | **Ask from Editor Area Thread selection.** Given text selected in a Thread transcript hosted in the Editor Area, When *Ask in Side Chat* runs, Then a new Thread opens in the Secondary Side Bar with a Selection Attachment carrying the exact text and source Thread/Turn ids; the original Thread and its Turns stay unchanged. | P |
| P1-AS-034 | **Ask from Secondary Side Bar Thread selection.** Given text selected in a Thread transcript hosted in the Secondary Side Bar, When *Ask in Side Chat* runs, Then a new Thread opens as a chat editor in the active Editor Area group with that Selection Attachment; the original Thread stays open and unchanged. | P |

### Manual QA snapshot — 2026-09-18

The run used `scripts/code-min.sh`, disposable `a.md`/`b.md` fixtures, and a Qwen text binding.
These are observations of that build, not implementation claims. **Partial** means only the
listed visible portion was checked; **blocked** means the required fixture or capability was
unavailable. P1-AS-005 passed the *old* Side Bar expectation; its revised Editor Area expectation
above remains open.

| ID | Result | Observed evidence / remaining gap |
| --- | --- | --- |
| P1-AS-001 | Partial | `a.md` kept text and attachment; `b.md` was blank. Its numeric counter was not visible. |
| P1-AS-002 | Fail | Moving `a.md` into a group already holding it lost the destination Tab's Draft. |
| P1-AS-003 | Pass | `a.md` and `b.md` retained separate Threads and Turns. |
| P1-AS-004 | Fail | Compact `New` expanded the host but did not create or activate a Thread. |
| P1-AS-005 | Passed old expectation; gap under revision | Title `+` opened Secondary Side Bar, including from Welcome. The revised requirement is Editor Area. |
| P1-AS-006 | Fail | No usable `Ask in Side Chat` action appeared for an editor selection. |
| P1-AS-007 | Fail | Upstream `Add Selection to Chat` attached to the Side Bar, not the Tab Draft. |
| P1-AS-008 | Fail | `Latent: Open Side Chat` from the Side Bar did not open the same Thread as a chat editor. |
| P1-AS-009 | Partial | Move collapsed the floating host and focused the Side Bar; Thread identity was not confirmed. |
| P1-AS-010 | Pass | After removing `#3`, the next attachment was `#5`; existing numbers remained stable. |
| P1-AS-011 | Fail | Compact Send blocked invalid `#7`, but expanded chat Send transmitted `see #7`. |
| P1-AS-012 | Fail | A stale diagnostic appeared, but clicking `Fix References` expanded the host without opening the re-add action. |
| P1-AS-013 | Unverified | The model-facing rewritten request was not observable in the manual UI. |
| P1-AS-014 | Pass | Editing U1 created a second Branch and preserved the original U1→A1→U2→A2 projection. |
| P1-AS-015 | Fail | Original U1 showed `1 / 2`; the edited sibling showed no version controls. |
| P1-AS-016 | Fail | Editing during an active request created a Branch without the required confirmation. |
| P1-AS-017 | Partial | Workbench Threads appeared; Harness/Bot fixtures and day grouping were not verified. |
| P1-AS-018 | Partial | Branch and Turn columns appeared; Enter opening the selected Branch as Side Chat was not confirmed. |

### Additional field observations — 2026-09-19

These items were reported with screenshots and have not been independently rerun. They extend the
acceptance scenarios above rather than changing the 2026-09-18 results.

| User item | Observation | Requirement / next check |
| --- | --- | --- |
| 2 | Editor title `+` opens the Secondary Side Bar; desired host is the Editor Area. | P1-FR-043; retest P1-AS-005. |
| 5 | After context is added, `#` in the Floating Composer lacks the Side Bar input's candidate list. | P1-FR-056; P1-AS-030. |
| 6 | `#` and `@` show overlapping upstream suggestions. | P1-FR-056 records distinct meanings and preserves existing upstream completion behavior. |
| 7 | *Add to Chat* lacks an optional comment input beside selected text. | P1-FR-034; P1-AS-027. |
| 8 | The selected model label can consume too much toolbar width. | P1-FR-013; P1-AS-031. |
| 11 | Floating Composer Enter and Send do not submit; switching loses the Draft, while global and Side Bar chat work. | P1-FR-025/026; P1-AS-028/029. Treat as a blocking regression in the tab composer path. |
| Follow-up: Sessions | Typing `>sesi` should expose a show-all Sessions action and an optional Finder-style column presentation. | P1-FR-070–075; P1-AS-017/018/032. |
| Follow-up: Thread Ask | `Ask in Side Chat` on a transcript selection in either host should open a **new** Thread in the opposite host. | P1-FR-032/040/041; P1-AS-033/034. |

### Fix implementation and computer-use retest — 2026-09-19

This is a new run, not a replacement for the baseline above. Launched with `scripts/code-min.sh`
using the fixture workspace. Computer use drove the native workbench and separate Selection Bar
window; Qwen3 Max used the user-supplied endpoint and secret (the secret is not recorded here).
A disposable profile was used for the successful live text checks. A subsequent normal launch
was blocked in macOS Keychain; a main-process sample showed `SecItemCopyMatching` / decryption,
and computer use refused access to `com.apple.SecurityAgent`. Secure restart validation requires
the user to handle that system prompt. No insecure credential fallback was introduced.

| Scenario | Latest result | Evidence / qualification |
| --- | --- | --- |
| P1-AS-001 | Partial retest | File draft survived switching to Providers and back, collapse/expand, and window reload. Multi-file isolation remains covered by the draft regression suite and the baseline. |
| P1-AS-002 | Known baseline failure remains | Moving onto an already-open identical resource can merge tab identity and replace the destination draft; this run did not resolve that collision. |
| P1-AS-003 | Baseline retained | Close/persistence scenario not independently rerun in this fix pass. |
| P1-AS-004 | Baseline retained | No new result is claimed for this scenario. |
| P1-AS-005 | Pass | Editor title `+` opened a new Chat editor tab; sidebar was retained. |
| P1-AS-006–008 | Baseline retained | No new result is claimed for these scenarios. |
| P1-AS-009 | Fix applied; retest required | Open/move now resolves the existing Thread. A cross-host retest exposed restored-session ownership loss; `ThreadService` now retains adopted/restored models. Targeted lifetime regression passes, but the final ownership fix still needs a UI rerun. |
| P1-AS-010 | Pass | Removing an attachment disabled its reference; re-add allocated `#2` and rewrote `#1` to `#2`, preserving monotonic numbering. |
| P1-AS-011 | Pass | Compact Send disabled for a removed reference. In expanded input, both Enter and Send kept `Blocked #999` in the input and added no request. |
| P1-AS-012 | Pass | Compact Fix References opened Re-add/Remove choices; re-add restored context and rewrote the reference. Expanded Fix References offered removal for `#999`. |
| P1-AS-013 | Known gap | The transcript currently displays model-facing rewritten text such as `Explain [#2: Selection (hello_world.py:2)]`, rather than a concise clickable `#2` display. |
| P1-AS-014 | Baseline retained | Branch creation was not independently rerun here. |
| P1-AS-015 | Fix applied; UI retest required | Fork-turn ownership includes the edited turn itself; a regression test checks both versions and the edited sibling index. |
| P1-AS-016 | Fix applied; UI retest required | Editing an active request asks for Stop and Edit confirmation before cancellation. |
| P1-AS-017 | Partial | Workbench Threads appear in Sessions. Empty titles now fall back to New Thread. Harness/Bot fixtures and complete cross-source coverage remain unverified. |
| P1-AS-018 | Partial | Columns displayed Original, both user/assistant turns and previews; selecting a Thread opened its conversation in the sidebar. Full keyboard branch navigation remains unverified. |
| P1-AS-027 | Pass | Code selection → Add to Chat opened an anchored Optional comment field; submitting attached the selection and appended `Explain this greeting` to the draft without sending. |
| P1-AS-028 | Pass before reload | Compact click Send received `OK`; Enter received `ENTER_OK`, each from Qwen3 Max. Expanded submission used the common validation path. After reload, model availability was lost in the disposable profile, so secure-profile continuity is not claimed. |
| P1-AS-029 | Partial | Draft survived editor/provider navigation, compact/expanded switching and reload. Thread/group collision behavior remains as AS-002. |
| P1-AS-030 | Partial | Typing `#` displayed `#1 Selection (hello_world.py:2)` and More Context. Enter selected the candidate without sending. Native expanded suggestions displayed tools such as `#agent` and `#codebase`; exhaustive keyboard/IME parity is not claimed. |
| P1-AS-031 | Partial | Model label now has a bounded width/ellipsis rule; normal Qwen label and Send were visible. The original long-endpoint label has not been recreated in the final build. |
| P1-AS-032 | Pass for workbench data | `>sesi` found Show All Sessions in Sidebar. List/Columns toggled, and Columns remained selected after Reload Window. Column minimum widths and row line height were corrected after screenshot inspection. |
| P1-AS-033 | Fix applied; retest required | Editor transcript selection displayed Ask in Side Chat and created a sidebar conversation with selection context. The first run exposed loss of the original restored model; the later ownership fix is unit-verified but not yet manually certified. |
| P1-AS-034 | Pass before reload | Sidebar transcript selection opened a new editor Chat with Selection (thread) context while the source sidebar conversation remained visible. |

Additional fixes found during this run: removed a recursive diagnostics/plugin event loop; corrected
floating transcript foreground to the theme foreground token; removed automatic expansion merely
on input focus; preserved drafts during model rebinding; added keyboard code-selection capture.
Selection actions now explicitly refocus their target workbench after hiding the native overlay
(the main-process focus change needs a post-restart UI check).

Validation: client typecheck and transpilation completed; targeted draft, provider-secret migration,
and Thread lifetime/version tests run with the repository Electron harness. Protocol tests are
listed in Part 2. These results do **not** certify all P1 scenarios as passing.

### Persistent-profile follow-up — 2026-09-19

Supersedes the outstanding results in the earlier snapshot only where stated below. The user
resolved the system Keychain prompt. This run used the normal stable `scripts/code-min.sh`
profile, a complete Quit/relaunch, the supplied Qwen endpoint with Qwen3 Max, and native computer
use. Credentials are deliberately omitted from this document.

| Scenario | Follow-up result | Observed evidence |
| --- | --- | --- |
| P1-AS-001/029 | Pass for tested navigation | The file's `KEEP_DRAFT_AFTER_MOVE` survived switching to another Thread, moving its conversation to the sidebar, and opening another editor group. Earlier reload/compact/expanded checks remain valid. |
| P1-AS-002 | Pass for revised collision contract | Split `hello_world.py` into two groups. First retained `KEEP_DRAFT_AFTER_MOVE`; second began empty and received `GROUP_TWO_DRAFT`. Move Editor into Previous Group showed the collision guard; both file tabs and both exact drafts remained. A second check moved the file into a group containing only `README.md`; its exact draft and original Thread binding followed it. |
| P1-AS-003 | Pass | Sending `SECOND_TURN_OK` in the editor Thread did not add a turn to the distinct sidebar Thread. |
| P1-AS-008/009 | Pass for editor-to-sidebar move | Moving the file's existing Thread to the sidebar kept its question and answer, collapsed/unbound the floating host, and preserved the file draft. The reverse open-same-Thread action was not repeated here. |
| P1-AS-013 | Pass | Sent `What does #1 print? Reply briefly.` with the selected print statement. Qwen returned `Hello, World!`. Transcript retained the short `#1` token; clicking it showed the selected plain text without entering message edit. Both transcript and preview survived Reload Window. Parser regression verifies the model-facing expansion separately. |
| P1-AS-014/015 | Pass | Built two user/assistant turns, edited the first request, and received `BRANCH_OK`. New projection showed `2 / 2`; Previous restored both original turns (`EDITOR_COPY_OK`, `SECOND_TURN_OK`), Next returned to the new answer without a generation. |
| P1-AS-016 | Pass for both confirmation outcomes | While a long response streamed, Edit displayed Stop and Edit / Cancel. Cancel left generation running and version count unchanged. In a subsequent live request Stop and Edit cancelled generation and prepared the original text in the new branch input. |
| P1-AS-017 | Partial | Workbench Threads are visible. Follow-up implementation imports already-known upstream agent sessions without creating a new chat session, preserving their source times, and adds date headers. Live Harness and runtime Bot fixtures have not been supplied. Runtime entries now adopt their existing resource and resolve through a read-only content provider; this path is covered by projection/event tests, not a live Bot fixture. Do not certify full cross-source acceptance. |
| P1-AS-018/032 | Pass for workbench branch navigation | After fixing single-click focus theft, single click selected the Thread without opening it; Right entered Branches, Right entered Turns and showed the preview, Left returned to Branches, and Enter opened the selected original two-turn branch in Side Chat. Columns mode survived reload. |
| P1-AS-027/028 | Pass | Keyboard-selected code opened the optional comment form. Added `What does #1 print? Reply briefly.` without sending; clicking compact Send produced a real model answer. Add to Chat returned focus to the correct workbench. |
| P1-AS-033 | Pass after reload | Selected `EDITOR_COPY_OK` in the editor transcript, chose Ask in Side Chat, and got a new empty sidebar Thread with one explicit Selection (thread) attachment. Source editor history and draft remained visible. |
| P1-AS-034 | Pass after reload | Selected `It prints:` in the sidebar answer, chose Ask in Side Chat, and got a new editor Thread. The original sidebar question, answer and draft remained. The new Thread accepted a real Qwen request. |

AS-002 now documents collision prevention because the upstream editor group merges identical
resources. The implementation preserves both existing tabs instead of overwriting either draft.
This was the stated default while the optional preference question remained unanswered.

Sessions now imports existing upstream agent sessions using their original session resource and
source timestamps. Runtime session rows likewise adopt the existing `latent-runtime` resource;
a read-only chat content provider projects user/tool/assistant history without running a Bot or
creating a replacement session. Source change notifications refresh the list, and duplicate rows
are removed by Thread id. Live external Harness/Bot fixtures are still an explicit acceptance gap.

The `#` context/tool candidates and `@` participant candidates are upstream chat capabilities;
Latent adds stable numeric `#n` attachment references, their candidate list, validation and preview.
An actual input example is kept separate from model-facing expansion through dynamic reference
parts, including serialized preview metadata. Clicking a numeric reference stops event propagation
so the native click-to-edit handler does not intercept it.

A subsequent reload exposed a separate branch-persistence defect: `toExport()` created imported
transcripts, which the upstream session store intentionally excludes. Branch creation now uses
full serialized session data with a fresh session id, cleared input/queue state and a new creation
time. A new regression checks that the branch satisfies the persistent-session schema while the
source identity remains unchanged. Computer use then created another edited branch, received
`PERSISTENT_BRANCH_OK`, reloaded the window, and verified the same answer, `6 / 6` version label,
and one-turn count in Sessions. Older ephemeral branches created during this smoke run cannot
be recovered after their earlier reload; this fix protects newly created branches.

Final validation: client typecheck and transpilation completed successfully; 60 focused Electron
tests passed (request parser, editor move guard, drafts, Thread ownership/version/persistence, runtime transcript projection and source change events).
`git diff --check` passed. Earlier provider/selection results remain applicable. This is not a
blanket Pass for all acceptance scenarios; cross-source Harness/runtime integration and the
explicitly untested cases above remain qualified.

## 8. Reuse inventory

Inventory date: 2026-09-18. Versions are the latest release tags observed on that date and must
be re-verified when vendoring.

| Component | Upstream version | Source | License | Notices to retain | Use in Part 1 |
| --- | --- | --- | --- | --- | --- |
| Hermes Agent | v2026.9.14 (Python) | https://github.com/NousResearch/hermes-agent | MIT | `LICENSE`: "Copyright (c) 2025 Nous Research"; add to `ThirdPartyNotices.txt` | Ported (reimplemented in TypeScript) for Gateways, Bots, Memory store, Runtime Capabilities, Artifacts, Scheduled Jobs. Hosted rooms excluded. |
| Funes | v1.3.1 (Rust) | https://github.com/huggingface/funes (`docs/recall.md`) | Apache-2.0 | `LICENSE`; no `NOTICE` file present on the inventory date (re-check when vendoring); state changes if the binary is redistributed | Recall pipeline and agent-format output contract reimplemented in TypeScript; optional adapter to a user-installed binary |
| Mem0 | latest tag observed `openclaw-v1.2.0` (Python; JS SDK separately tagged) | https://github.com/mem0ai/mem0 | Apache-2.0 | `LICENSE` if the JS SDK is bundled | Memory Adapter only; disabled by default; never bundled in the core |
| Code-OSS chat, agent sessions, agent host | this fork (upstream microsoft/vscode) | in-tree | MIT | existing `LICENSE.txt` | ChatModel projection, sessions viewer, Harness access |
| SQLite (via `@vscode/sqlite3`) | in-tree dependency | in-tree | Public domain / MIT wrapper | existing notices | Thread tree, runtime DB, recall FTS5 |

Licensing obligations: MIT and Apache-2.0 permit commercial use; retain the license texts and
copyright lines above in `ThirdPartyNotices.txt`. Apache-2.0 additionally requires that any
modified Funes source files carry a change notice if Funes code (not only its documented
behaviour) is copied. No restrictive-license component is incorporated in Part 1.
