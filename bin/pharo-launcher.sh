#!/usr/bin/env bash

set -euo pipefail
set -f

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done

SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

if [ -z "${PHARO_LAUNCHER_IMAGE:-}" ] && [ -f "$ROOT/shared/PharoLauncher.image" ]; then
  PHARO_LAUNCHER_IMAGE="$ROOT/shared/PharoLauncher.image"
fi

if [ -z "${PHARO_LAUNCHER_IMAGE:-}" ]; then
  IMAGE_CANDIDATE="$(find "$SCRIPT_DIR" "$ROOT" -maxdepth 1 -name "*.image" -print -quit 2>/dev/null || true)"
  if [ -n "$IMAGE_CANDIDATE" ]; then
    PHARO_LAUNCHER_IMAGE="$IMAGE_CANDIDATE"
  fi
fi

if [ -z "${PHARO_LAUNCHER_VM:-}" ] && [ -x "$ROOT/pharo-vm/pharo" ]; then
  PHARO_LAUNCHER_VM="$ROOT/pharo-vm/pharo"
fi

if [ -z "${PHARO_LAUNCHER_IMAGE:-}" ]; then
  echo "PHARO_LAUNCHER_IMAGE is required or a packaged image must exist next to the launcher script" >&2
  exit 1
fi

if [ -z "${PHARO_LAUNCHER_VM:-}" ]; then
  echo "PHARO_LAUNCHER_VM is required or a packaged VM must exist under pharo-vm" >&2
  exit 1
fi

"$PHARO_LAUNCHER_VM" --headless "$PHARO_LAUNCHER_IMAGE" --no-default-preferences clap launcher "$@"
