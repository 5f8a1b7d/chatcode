#!/usr/bin/env bash

set -euo pipefail

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")
fi

PRELAUNCH=false
FRESH_PROFILE=false
USER_ARGS=()

while [[ $# -gt 0 ]]; do
	case "$1" in
		--fresh-profile)
			FRESH_PROFILE=true
			shift
			;;
		--prelaunch)
			PRELAUNCH=true
			shift
			;;
		--help|-h)
			cat <<'EOF'
Usage: ./scripts/code-min.sh [--prelaunch] [--fresh-profile] [path-or-code-options...]

Launch an already-built Code OSS workbench with a persistent per-checkout profile,
Latent Provider, Latent Selection, and GitHub Copilot Chat enabled. Opens the
paper-and-Python fixture in scripts/fixtures/code-min by default. Provider settings and credentials survive restarts. Use --fresh-profile for
an isolated profile that is removed after the window closes.

Options:
  --fresh-profile  Use a disposable profile and in-memory secrets.
  --prelaunch  Run the normal download/build preparation before launching.
  --help, -h   Show this help.

Examples:
  ./scripts/code-min.sh
  ./scripts/code-min.sh --prelaunch
  ./scripts/code-min.sh /path/to/small/project
EOF
			exit 0
			;;
		--)
			shift
			USER_ARGS+=("$@")
			break
			;;
		*)
			USER_ARGS+=("$1")
			shift
			;;
	esac
done

cd "$ROOT"

if [[ "$PRELAUNCH" == true ]]; then
	node build/lib/preLaunch.ts
fi

if [[ "$OSTYPE" == "darwin"* ]]; then
	NAME=$(node -p "require('./product.json').nameLong")
	EXE_NAME=$(node -p "require('./product.json').nameShort")
	CODE="./.build/electron/$NAME.app/Contents/MacOS/$EXE_NAME"
else
	NAME=$(node -p "require('./product.json').applicationName")
	CODE="./.build/electron/$NAME"
fi

if [[ ! -x "$CODE" || ! -f out/main.js ]]; then
	echo "Code OSS build output is missing." >&2
	echo "Run './scripts/code-min.sh --prelaunch' once, or run 'npm run compile'." >&2
	exit 1
fi

if [[ ! -f extensions/latent-provider/out/extension.js || ! -f extensions/latent-selection/out/extension.js || ! -f extensions/copilot/dist/extension.js ]]; then
	echo "Latent Provider, Latent Selection, or Copilot extension build output is missing." >&2
	echo "Compile those extensions before launching the lightweight preview." >&2
	exit 1
fi

DISABLED_EXTENSION_ARGS=()
while IFS= read -r extension_id; do
	DISABLED_EXTENSION_ARGS+=("--disable-extension=$extension_id")
done < <(
	node <<'NODE'
const fs = require('fs');
const path = require('path');
const enabledExtensionIds = new Set([
	'latentnote.latent-provider',
	'latentnote.latent-selection',
	'GitHub.copilot-chat',
	'vscode.github-authentication'
]);

for (const root of ['extensions', '.build/builtInExtensions']) {
	if (!fs.existsSync(root)) {
		continue;
	}
	for (const entry of fs.readdirSync(root)) {
		const manifestPath = path.join(root, entry, 'package.json');
		if (!fs.existsSync(manifestPath)) {
			continue;
		}
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		if (manifest.publisher && manifest.name) {
			const extensionId = `${manifest.publisher}.${manifest.name}`;
			if (!enabledExtensionIds.has(extensionId)) {
				console.log(extensionId);
			}
		}
	}
}
NODE
)

SECRET_ARGS=()
if [[ "$FRESH_PROFILE" == true ]]; then
	TMP_BASE=${TMPDIR:-/tmp}
	RUN_DIR=$(mktemp -d "${TMP_BASE%/}/code-oss-min.XXXXXX")
	SECRET_ARGS+=(--use-inmemory-secretstorage)
else
	REPO_ID=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").realpathSync(process.cwd())).digest("hex").slice(0, 12))')
	if [[ "$OSTYPE" == "darwin"* ]]; then
		PROFILE_BASE="$HOME/Library/Application Support/LatentDev"
	else
		PROFILE_BASE="${XDG_DATA_HOME:-$HOME/.local/share}/latent-development"
	fi
	RUN_DIR="$PROFILE_BASE/$REPO_ID"
fi
USER_DATA_DIR="$RUN_DIR/user-data"
EXTENSIONS_DIR="$RUN_DIR/extensions"
SHARED_DATA_DIR="$RUN_DIR/shared-data"
PREVIEW_DIR="$ROOT/scripts/fixtures/code-min"
mkdir -p "$USER_DATA_DIR/User" "$EXTENSIONS_DIR" "$SHARED_DATA_DIR"

CODE_MIN_SDK_ROOT="$ROOT" CODE_MIN_SETTINGS_PATH="$USER_DATA_DIR/User/settings.json" node <<'NODE'
const fs = require('fs');
if (!fs.existsSync(process.env.CODE_MIN_SETTINGS_PATH)) {
fs.writeFileSync(process.env.CODE_MIN_SETTINGS_PATH, JSON.stringify({
	'chat.disableAIFeatures': false,
	'chat.agentHost.codexAgent.enabled': true,
	'chat.agentHost.codexAgent.sdkRoot': process.env.CODE_MIN_SDK_ROOT,
	'chat.editor.codex.preferAgentHost': true,
	'extensions.autoCheckUpdates': false,
	'git.enabled': false,
	'npm.autoDetect': 'off',
	'task.autoDetect': 'off',
	'typescript.disableAutomaticTypeAcquisition': true,
	'workbench.startupEditor': 'readme'
}, null, 2) + '\n');
}
NODE

cleanup() {
	if [[ "$FRESH_PROFILE" == true ]]; then
		rm -rf "$RUN_DIR"
	fi
}
trap cleanup EXIT

if [[ ${#USER_ARGS[@]} -eq 0 ]]; then
	if [[ ! -f "$PREVIEW_DIR/README.md" ]]; then
		echo "Default preview fixture is missing: $PREVIEW_DIR" >&2
		exit 1
	fi
	USER_ARGS=("$PREVIEW_DIR")
fi

export NODE_ENV=development
export VSCODE_DEV=1
export VSCODE_CLI=1
unset ELECTRON_RUN_AS_NODE

echo "Starting lightweight Code OSS preview (Latent Provider, Latent Selection, and Copilot enabled)."

"$CODE" . \
	--new-window \
	--user-data-dir="$USER_DATA_DIR" \
	--extensions-dir="$EXTENSIONS_DIR" \
	--shared-data-dir="$SHARED_DATA_DIR" \
	--extensionDevelopmentPath="$ROOT/extensions/copilot" \
	"${DISABLED_EXTENSION_ARGS[@]}" \
	--disable-workspace-trust \
	--disable-telemetry \
	--disable-experiments \
	--disable-updates \
	--disable-crash-reporter \
	--skip-welcome \
	--skip-release-notes \
	${SECRET_ARGS[@]+"${SECRET_ARGS[@]}"} \
	--no-cached-data \
	"${USER_ARGS[@]}"
