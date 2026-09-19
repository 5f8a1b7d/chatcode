# Latent AI Workbench Specifications

This folder holds the formal specifications for the three-part AI workbench built on the Latent
fork of Code-OSS. The three parts share one vocabulary, one set of interface boundaries, and one
acceptance-scenario format so that they can be implemented and verified independently.

| Part | File | Visibility | Status |
| --- | --- | --- | --- |
| 1 | [01-ai-interaction.md](01-ai-interaction.md) | Public, committed | Draft for review |
| 2 | [02-selection-provider-extensions.md](02-selection-provider-extensions.md) | Public, committed | Draft for review |
| 3 | `03-private-derivative.md` | **Local only.** Ignored through the exact rule `/specs/03-private-derivative.md` in `.gitignore`. Moves to the private derivative repository after the public release. | Draft for review |

The two product screenshots under `screenshots/` are interaction references for the side chat and
for selection annotations only. Text inside them is not a product requirement.

The [Part 1](01-ai-interaction.md) and [Part 2](02-selection-provider-extensions.md) acceptance sections
record the 2026-09-18 manual QA results, the separately labeled 2026-09-19 field observations,
and the 2026-09-19 fix/computer-use retest tables. The latter distinguish live UI passes,
unit-verified fixes, known gaps and the blockers at the time of each run. The latest
Persistent-profile follow-up records the resolved Keychain issue, real Gemini Live handshake and
secure restart, Qwen UI smoke tests, and the subsequently fixed branch-persistence regression.
Audible voice/local-backend and live external-session cases remain explicitly qualified.
These status snapshots describe the tested build; the requirement and acceptance rows describe
the intended behavior for subsequent implementation and retesting.

## Conventions used by every specification

- **Requirement IDs** are `P<part>-FR-<nnn>`. **Acceptance scenarios** are `P<part>-AS-<nnn>` and are
  written as Given / When / Then so they map one-to-one onto an automated test or a scripted
  manual run. Each scenario names its harness (unit, Playwright through the `launch` skill,
  smoke, or manual).
- Every specification contains the same eight sections: Scope and succession, User flows, Module
  boundaries, Extension interfaces, Failure states, Migration strategy, Acceptance scenarios, and
  Reuse inventory.
- Fork rules from [FORK.md](../FORK.md) apply: new behaviour lives in fork-owned folders, upstream
  files receive only single-line registration seams marked with a `Latent` comment, and nothing
  upstream is deleted to make room for fork code.
- Settings introduced by these specifications use the `latent.*` namespace. Existing
  `latentnote.studyBuddy.*` and `chat.customProviders.*` keys keep working through the migration
  rules in Part 2.
- Licensing: prefer upstream projects that permit commercial use. A project under a restrictive
  license (AGPL, SSPL, non-commercial) is used only as a behavioural or architectural reference,
  and the required functionality is reimplemented independently. Each part records its own reuse
  inventory with upstream version, source, license, and the notices that must be retained.

## Shared glossary

The terms below are used with exactly this meaning in all three parts.

| Term | Meaning |
| --- | --- |
| **Workbench** | The Code-OSS desktop window: activity bar, primary side bar, editor area, panel, secondary side bar, status bar. |
| **Editor Area** | The editor part that hosts editor groups and their tabs. |
| **Tab** | One editor input opened in one editor group. A tab is *editable* when its input is a text, notebook, or custom editor whose model can be modified. Identified by a `TabKey` (Part 1). |
| **Secondary Side Bar** | Upstream's auxiliary bar. It is the default host of the chat view container. |
| **Side Chat** | A full chat widget bound to one Thread. It is hosted either in the Secondary Side Bar (chat view pane) or in the Editor Area (chat editor). Which one is chosen follows the *open-location rule* in Part 1. |
| **Floating Composer** | The compact, draggable input box overlaid on an editable Tab. Each editable Tab owns exactly one Floating Composer state. |
| **Floating Window** | The system-level, always-on-top window defined in Part 2. It is a separate OS window, not part of the Workbench. |
| **Draft** | The unsent input state of one Tab: text, ordered Attachments, and the attachment counter. Drafts never move between Tabs. |
| **Attachment** | A context item added to a Draft: file, selection, image, symbol, or any upstream chat variable entry. Every Attachment receives an **Attachment Number** in order of addition. |
| **Thread** | One conversation. A Thread is a tree of Turns with an active Branch. Backed by one upstream chat session resource per Branch materialisation. |
| **Turn** | One user message or one assistant response inside a Thread. |
| **Version** | A user Turn that was created by editing another user Turn. Versions are siblings under the same parent Turn. |
| **Branch** | A root-to-leaf path through a Thread's Turn tree. Editing a Turn creates a new Branch; the original Branch is preserved. |
| **Selection** | Text selected in a Code-OSS editor (editor selection), in a Thread transcript (thread selection), or in another desktop application (system selection). |
| **Selection Bar** | The floating toolbar shown next to a Selection. Part 2 owns it. |
| **Selection Action** | One command exposed in the Selection Bar. Built-in and extension-contributed actions share one extension point. |
| **Provider** | A configured model service (base URL, protocol, credential, models). Part 2 owns providers. |
| **Provider Capability** | A modality a Provider can serve: `text`, `imageUnderstanding`, `asr`, `tts`, `realtimeVoice`. |
| **Capability Binding** | The resolved pairing of a Provider Capability request with one Provider and one model. |
| **Harness** | An agent execution environment reachable through the upstream Agent Host: Copilot, Codex, or Claude Code. Harnesses run locally. |
| **Managed Runtime** | The application-managed TypeScript/Node.js background service defined in Part 1. It hosts Gateways, Bots, Memory, Runtime Capabilities, Artifacts, and Scheduled Jobs, and outlives the Workbench window. |
| **Gateway** | A Managed Runtime adapter to an external messaging platform (Telegram, Discord, Slack, WhatsApp, Signal, webhook). |
| **Bot** | A named Managed Runtime agent configuration: system prompt, model binding, tool authorization scope, and Gateway bindings. |
| **Runtime Capability** | A skill package (agentskills.io layout) or toolset that a Bot may load. Distinct from Provider Capability. |
| **Artifact** | A file produced by a Bot or Harness run, stored by the Managed Runtime with provenance. |
| **Scheduled Job** | A cron- or interval-scheduled Bot run with a delivery target. |
| **Memory Store** | The local, user-editable memory (memory notes and user profile) plus the local **Recall Index** over Threads and runtime sessions. |
| **Memory Adapter** | An optional connector to an external memory system (for example Mem0). Disabled unless the user enables it. |
| **Tool Authorization Scope** | The explicit list of tools and resource patterns a Bot or agent may use without a per-action prompt. |
