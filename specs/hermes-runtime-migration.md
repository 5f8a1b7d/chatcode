# Hermes runtime migration

The runtime reuses the existing chatcode Bot, gateway, scheduler, artifact and capability services. The workbench adapts Hermes' roster actions to native view panes and context menus. Sessions navigation remains in its existing location.

## Upstream reference map

Source: the local `hermes-agent-main` checkout, MIT license (see [license](../resources/latent/hermes-LICENSE.txt)).

| Behavior | Hermes source | chatcode implementation |
| --- | --- | --- |
| Bot row actions, canonical chat vs recent session, pin/hide/edit/duplicate/delete, section filing | `apps/desktop/src/plugins/hermes-bots/bot-row.tsx` | `runtimeViews.ts`, native chat session provider |
| Scheduled job editing, deletion, execution output and refresh | `apps/desktop/src/app/cron/index.tsx`, `cron-actions.ts` | `runtimeViews.ts`, existing scheduler/execution ledger |
| Capabilities, messaging, artifact entry points | `apps/desktop/src/app/{capabilities,messaging,artifacts}` | Five independent Activity Bar containers |
| Bounded persistent entry lists, exact deduplication, unique substring matching, atomic batches, frozen context | `tools/memory_tool_store.py`, `tools/memory_tool.py` | `memoryStore.ts`, `session_memory` snapshots |
| Periodic background review, yielding to new input, skipping cron, pre-compression evidence | `agent/background_review.py`, `agent/turn_context.py`, `agent/conversation_compression.py` | `memoryLifecycle.ts`, BotRunner review, workbench completion and summarization hooks |
| Strict memory threat patterns | `tools/threat_patterns.py` | `memorySafety.ts` (ported pattern table) |
| Browse/search/read historical messages with bounded output | `tools/session_search_tool.py` | `session_search`, runtime search/read RPC, workbench language-model tools |

The managed runtime is enabled by default; an explicit user setting disabling it is respected. The memory port keeps existing chatcode `memory/MEMORY.md` and `USER.md` paths and reads its older heading/bullet format. New writes use Hermes' `\n§\n` delimiter. Defaults match Hermes: 2,200 characters for notes and 1,375 for the user profile. Replacement/deletion proposals persist across restarts and appear in Capabilities → Memory. Direct editor changes remain possible. A conversation gets one persistent memory snapshot, including across application restarts; new conversations see subsequent edits.

Every ten completed user turns, Bot and ordinary workbench conversations run a bounded memory-only review through their existing model. It never calls external tools; its JSON plan passes through the same validation, capacity limits, atomic batches and destructive-change review. New input cancels the session's in-flight review, and scheduled jobs/read-only Bots skip it. Before workbench context compression, text/tool evidence is saved as a content-addressed checkpoint, indexed for later recall. Checkpoints retain their parent session URI; history searches exclude the active session and its checkpoints. The native transcript remains the fallback if the runtime was explicitly disabled.

## Menus and output paths

- Bots: Open Bot Chat, Pin/Unpin, Hide/Unhide, Edit, Duplicate, New Chat, Open Recent Session, Move to Section, Delete.
- Scheduled Jobs: View Runs and Output, Run Now, Pause/Resume, Edit, Duplicate, Delete. A successful run opens its conversation; failed/skipped runs expose the recorded status/error. Deleting or editing a job during execution cannot be undone by the completion handler.
- Messaging: Configure answering bot, Pairing Code, Connect/Disconnect, Send Message, Delete; gateway conversations open beneath the connections.
- Artifacts: Open, Open Source Session, Copy Path, Reveal in File Explorer, Delete.
- Capabilities: native Tools/MCP/Extensions entry points; skill instructions, bot assignment, path copy and removal; local memory files, pending edits and adapter review.

The row overflow button, right-click menu and Shift+F10 share one action list. Hermes-specific account/cloud/workspace-group integrations are not transplanted into the general-purpose runtime.

## Funes

The optional executable is discovered through `LATENT_FUNES_PATH`, `PATH`, or `~/.local/bin/funes` (`funes.exe` on Windows). It is not bundled. The actual Funes embedding/BM25/reranking pipeline runs in a profile-local `memory/funes` directory, and never publishes history to a remote repository.

The published Funes 1.3.1 binary does not support the newer main-branch `.funes.jsonl` format. The integration therefore uses its documented native Hermes SQLite reader: an append-only `messages` projection in `runtime.db` supplies the supported columns. Each import uses `VACUUM INTO` to create a consistent `source/state.db` snapshot (the filename required by Funes), including committed WAL contents. Stable message IDs make repeated indexing idempotent; edited content is appended with a new identity. Funes reports `hermes` as the parser facet for these chatcode records; session IDs retain their original provenance. Direct turn reads use Funes' coordinates when available.

Completed runtime turns and completed workbench replies schedule indexing. Retrieval is an explicit agent tool call, not automatic transcript injection. Missing executables or indexing failures are visible in Capabilities; the local SQLite keyword index remains usable. Model downloads occur on first Funes use. A native Windows Funes binary is not supplied by the upstream release; that host needs a compatible executable before hybrid recall is available.

## Validation

Regression tests cover default files, legacy entries, concurrent writers, persistent proposals, safe prompt loading, batch failure atomicity, job deletion/pause during execution, recall ranking, current-session exclusion, and append-only Funes records. Actual Funes 1.3.1 smoke tests index both a synthetic fixture and the running application database, then recall Bot and workbench conversations with source turns. A separate isolated workbench verifies three consecutive Bot replies, persistent-memory injection, job execution output, native row menus, and confirmed deletion of Bot/job copies. Client and Copilot typechecks pass. The runtime suite passes 33 tests, and four additional extension lifecycle tests pass. Coverage includes lifecycle regressions for the ten-turn cadence, cancellation, scheduled/read-only exclusions, review validation and idempotent checkpoints. Screenshots are saved under `screenshots/runtime-migration/` (local verification artifacts).
