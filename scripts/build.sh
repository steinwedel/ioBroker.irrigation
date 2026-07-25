#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=false
NO_DEPLOY=false
BUMP="patch"

usage() {
    cat <<'EOF'
Usage: ./build.sh [options] [patch|minor|major]

Runs "npm run release <bump>" and, on success, "scripts/deploy.sh" (deploy.sh
next to this script).

Options:
  --dry-run     Only check and describe the release (no commit/tag/push).
                deploy.sh is never run in this mode, since nothing is released.
  --no-deploy   Perform a real release, but skip deploy.sh afterwards.
  -h, --help    Show this help and exit without doing anything.

Arguments:
  patch|minor|major   Version bump to release (default: patch).
EOF
}

for arg in "$@"; do
    case "$arg" in
        -h|--help)
            usage
            exit 0
            ;;
        --dry-run)
            DRY_RUN=true
            ;;
        --no-deploy)
            NO_DEPLOY=true
            ;;
        patch|minor|major)
            BUMP="$arg"
            ;;
        *)
            echo "Unknown option: $arg" >&2
            usage >&2
            exit 1
            ;;
    esac
done

cd "$PROJECT_DIR"

if [ "$DRY_RUN" = true ]; then
    npm run release "$BUMP" -- --dry-run
    echo "Dry run finished; nothing was released, deploy.sh was not run."
    exit 0
fi

npm run release "$BUMP"

if [ "$NO_DEPLOY" = true ]; then
    echo "Release finished; --no-deploy set, skipping deploy.sh."
    exit 0
fi

"$SCRIPT_DIR/deploy.sh"
