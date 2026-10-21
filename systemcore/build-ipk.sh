#!/usr/bin/env bash
# Builds the YAMS Live Tuner website and packages it as a SystemCore .ipk.
#
# Usage: systemcore/build-ipk.sh [--skip-site-build]
#
# Environment overrides:
#   PACKAGE_NAME  package and systemd unit name   (default: yams-tuner)
#   VERSION       package version                 (default: version in package.json)
#   PORT          port the web UI listens on      (default: 5812)
#   OUT_DIR       where the .ipk is written       (default: dist/)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PACKAGE_NAME="${PACKAGE_NAME:-yams-tuner}"
VERSION="${VERSION:-$(node -p "require('$REPO_ROOT/package.json').version")}"
VERSION="${VERSION#v}"
PORT="${PORT:-5812}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"

SKIP_SITE_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --skip-site-build) SKIP_SITE_BUILD=true ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

for tool in tar ar gzip; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done

IPK_NAME="${PACKAGE_NAME}_${VERSION}.ipk"
echo "Building $IPK_NAME (port $PORT)"

# 1. Build the static site. On SystemCore it is served from "/", so no base path.
if [ "$SKIP_SITE_BUILD" = false ]; then
  echo "Building website..."
  (cd "$REPO_ROOT" && NEXT_PUBLIC_BASE_PATH="" NEXT_TELEMETRY_DISABLED=1 pnpm build)
fi
[ -f "$REPO_ROOT/out/index.html" ] || { echo "out/index.html not found; build the site first" >&2; exit 1; }

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
DATA_DIR="$WORK_DIR/data"
CONTROL_DIR="$WORK_DIR/control"

# Replaces placeholders in file names and file contents.
render() {
  local src="$1" dest="$2"
  ( cd "$src" && find . -type f ) | while read -r rel; do
    local target="$dest/${rel//@PACKAGE@/$PACKAGE_NAME}"
    mkdir -p "$(dirname "$target")"
    sed -e "s|@PACKAGE@|$PACKAGE_NAME|g" \
        -e "s|@VERSION@|$VERSION|g" \
        -e "s|@PORT@|$PORT|g" \
        "$src/$rel" | tr -d '\r' > "$target"
  done
}

# 2. Stage package contents
echo "Staging files..."
render "$SCRIPT_DIR/overlay" "$DATA_DIR"
render "$SCRIPT_DIR/control" "$CONTROL_DIR"

mkdir -p "$DATA_DIR/usr/share/$PACKAGE_NAME"
cp -r "$REPO_ROOT/out" "$DATA_DIR/usr/share/$PACKAGE_NAME/www"
cp "$REPO_ROOT/public/apple-icon.png" "$DATA_DIR/usr/share/$PACKAGE_NAME.png"

# 3. Permissions
find "$DATA_DIR" -type d -exec chmod 755 {} +
find "$DATA_DIR" -type f -exec chmod 644 {} +
chmod 755 "$DATA_DIR/usr/local/bin/$PACKAGE_NAME/server.py"
chmod 644 "$CONTROL_DIR/control"
chmod 755 "$CONTROL_DIR/postinst" "$CONTROL_DIR/prerm" "$CONTROL_DIR/postrm"

# 4. Pack: control.tar.gz + data.tar.gz inside an ar archive, owned by root
TAR_OPTS=(--owner=0 --group=0 --numeric-owner --sort=name --format=gnu)
tar "${TAR_OPTS[@]}" -czf "$WORK_DIR/control.tar.gz" -C "$CONTROL_DIR" .
tar "${TAR_OPTS[@]}" -czf "$WORK_DIR/data.tar.gz" -C "$DATA_DIR" .

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$IPK_NAME"
(cd "$WORK_DIR" && ar rc "$OUT_DIR/$IPK_NAME" control.tar.gz data.tar.gz)

echo ""
echo "Created $OUT_DIR/$IPK_NAME"
echo "  Files: $(find "$DATA_DIR" -type f | wc -l)"
echo "  Size:  $(du -h "$OUT_DIR/$IPK_NAME" | cut -f1)"
echo "  UI:    http://<systemcore>:$PORT/"
