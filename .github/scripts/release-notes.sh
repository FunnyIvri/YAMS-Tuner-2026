#!/usr/bin/env bash
# Writes Markdown release notes to stdout.
#
# Usage: release-notes.sh <version> <ipk-path> [previous-tag]
# Needs full git history (actions/checkout with fetch-depth: 0).

set -euo pipefail

VERSION="$1"
IPK_PATH="$2"
PREV_TAG="${3:-}"

REPO="${GITHUB_REPOSITORY:-Yet-Another-Software-Suite/YAMS-Tuner}"
SERVER="${GITHUB_SERVER_URL:-https://github.com}"
REPO_URL="$SERVER/$REPO"
PAGES_URL="https://$(echo "${REPO%%/*}" | tr '[:upper:]' '[:lower:]').github.io/${REPO#*/}/"

IPK_NAME="$(basename "$IPK_PATH")"
IPK_SHA256="$(sha256sum "$IPK_PATH" | cut -d' ' -f1)"
PORT="${PORT:-5812}"

if [ -n "$PREV_TAG" ]; then
  RANGE="$PREV_TAG..HEAD"
else
  RANGE="HEAD"
fi

CHANGES="$(git log "$RANGE" --no-merges --reverse --format="- %s ([%h]($REPO_URL/commit/%H))")"
[ -n "$CHANGES" ] || CHANGES="- No changes since $PREV_TAG"

cat <<NOTES
## What's new

$CHANGES

NOTES

if [ -n "$PREV_TAG" ]; then
  echo "**Full changelog:** $REPO_URL/compare/$PREV_TAG...v$VERSION"
else
  echo "First release."
fi

cat <<NOTES

## Install on SystemCore

1. Download **\`$IPK_NAME\`** from the assets below.
2. Connect to the robot and open the SystemCore web interface at http://robot.local.
3. Drag and drop the \`.ipk\` onto the home page or the **Package Manager** tab, and wait for the install log to finish.
4. Open the \`yams-tuner\` package tile, or go to http://robot.local:$PORT/.

Installing a newer version over an older one upgrades it in place.

<details>
<summary>Install from the command line instead</summary>

Copy the package to the robot (for example with \`scp $IPK_NAME <user>@robot.local:/tmp/\`), then run as root on the robot:

\`\`\`bash
opkg install /tmp/$IPK_NAME
\`\`\`

To uninstall: \`opkg remove yams-tuner\`

</details>

## Use without installing

The latest build of the tuner is always hosted at $PAGES_URL. It needs a Chromium based browser (Chrome or Edge) to reach the robot from an HTTPS page.

## Checksum

| File | SHA-256 |
| --- | --- |
| \`$IPK_NAME\` | \`$IPK_SHA256\` |
NOTES
