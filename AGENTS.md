# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).

# Local development host memory

Before operating the Windows development host, Syncthing, SSH, the shared mihomo proxy, or the
Code-OSS Windows build, read `docs/local-development-host.md` when it exists. This file is
machine-specific and Git-ignored; verify live addresses and connectivity when observed state
conflicts with it.

# Validation limits

- Never run repository-wide or workspace-wide validation. This includes full builds, full lint runs,
  full test suites, and full typechecks. Validate only code added or changed in the current turn, or
  the specific existing workspace changes that the user explicitly asks to validate.
- Never run a repository-wide or workspace-wide TypeScript typecheck in this repository or in the
  sibling `latent` repository. In particular, do not run `npm run typecheck-client`, do not invoke
  `tsc` against the root/client `src/tsconfig.json`, and do not substitute another command that
  typechecks the entire project.
- Validate changes with the narrowest relevant file-, package-, extension-, or test-level command.
  Use targeted tests, linting, syntax checks, or a scoped extension/package `tsconfig.json` only.

# Copyright
All new files are not belonging to MicroSoft, no copyright header should be added to new files.
