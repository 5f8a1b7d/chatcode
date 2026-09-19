# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).

# Product scope

chatcode is a general-purpose IDE with chat and agents, comparable to Hermes or Codex. Only add
features that any user of a general-purpose IDE would want. Functionality tied to a particular
field, organization, or backend service (domain-specific bot tools, preset bots and their
prompts, proprietary server integrations) does not belong in this repository; it belongs in a
separate derivative. This repository only provides neutral extension points for derivatives
(runtime plugin registries, product overrides), and it never names or describes what a
derivative contains. When it is unclear whether a feature is general-purpose, ask before adding it.

# Local development host memory

Before operating the Windows development host, Syncthing, SSH, the shared mihomo proxy, or the
Code-OSS Windows build, read `docs/local-development-host.md` when it exists. This file is
machine-specific and Git-ignored; verify live addresses and connectivity when observed state
conflicts with it.

# Copyright
All new files are not belonging to MicroSoft, no copyright header should be added to new files.
