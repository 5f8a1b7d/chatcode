# Study Buddy

This built-in extension connects the native Code-OSS Markdown text editor to the Study Buddy Node
service. Select non-empty text in a `.md` or `.markdown` file and run **Study Buddy: Explain
Selection** from the editor toolbar, context menu, or Command Palette.

In the latentNote Code-OSS build, selecting text in another desktop application opens a floating
SelectionBar with Explain, Translate, Summarize, and Add to Context. Mouse selections in Code-OSS
text editors use the same bar through a direct editor bridge, without relying on the native hook
to read its own application's accessibility tree. System-wide selection is
enabled by default and can be disabled with `latentnote.studyBuddy.globalSelection.enabled`.
External context snapshots are stored in the current workspace and included in later selection
actions when relevant.

Set `latentnote.studyBuddy.serviceUrl` to the Node service base URL (the development checkout
defaults to `http://192.168.0.101:8787`; for a service on the same machine, use
`http://localhost:8787`). Use **Study Buddy: Set Access Token** to store an account bearer token in
VS Code Secret Storage. Set `latentnote.studyBuddy.projectId` to override the durable-memory
project identifier. When it is empty, the extension derives a stable identifier from the
containing workspace folder.

Unpackaged development launches (`VSCODE_DEV=1` and `NODE_ENV=development`) use the development
superuser token automatically for a private service URL when no account token is stored. The
lightweight `code-min.sh` preview keeps Secret Storage only in memory, so manually entered tokens
do not survive its restart.

## Chat and Agent Host

**Study Buddy** is an extension-contributed Custom Agent available in the Agent Host mode picker.
Choose Codex or Claude Code as the session harness, then choose **Study Buddy** as the agent mode.
The selected harness supplies its normal workspace, editing, terminal, and approval tools. The
Study Buddy extension also contributes `studybuddy_search_notes`, `studybuddy_search_memories`,
`studybuddy_save_memory`, and `studybuddy_explain_material`. Note search returns Markdown excerpts
and source lines from the current workspace. Memory search is scoped to the current Study Buddy
project; saving a memory asks for confirmation.

`@studybuddy` is a launcher for this Custom Agent. It lets you choose Codex or Claude Code, opens
the matching Agent Host session with **Study Buddy** selected, and forwards the prompt and file
references. Continue follow-up questions in that session after authenticating the selected
harness if prompted. The `/explain`, `/translate`,
`/summarize`, and `/code` shortcuts use the same route. The floating chat can still show its thread,
resize vertically, and move that thread into the Secondary Side Bar.

The **Study Buddy Service** model remains available for standalone text responses. It does not
provide coding tools. Set the Study Buddy access token to use the learning tools; development
preview launches can use the private-network development credential.

The Node service must be configured with `STUDYBUDDY_PYTHON_BASE_URL`. Memory records use the
directory containing `STUDYBUDDY_NATIVE_RUN_STATE_PATH` when that variable is set, otherwise they
default to `~/.studybuddy/extension-memories.json`. Set
`STUDYBUDDY_EXTENSION_MEMORY_STATE_PATH` to choose a different durable location.

## Provider catalog

Set `chat.customProviders.enabled` to `true`, then run **Study Buddy: Manage Providers** from the
Command Palette. The catalog follows OpenMAIC's Token Plan, LLM, Image, Video, TTS, ASR,
Document Parsing, and Web Search categories. You can configure built-in providers, add custom
providers, and enable a Token Plan's shared key for its listed services. Credentials are saved
in VS Code Secret Storage; provider settings are saved separately.

The editable source is [`media/provider-catalog.yaml`](media/provider-catalog.yaml). Run
`npm run catalog:compile` after changing it, which updates the JSON loaded by the extension.
The current request adapter exposes supported LLM protocols through the VS Code Language Model
API. Other catalog services have configuration and active-binding data but no generation or
parsing adapter in Study Buddy yet.
