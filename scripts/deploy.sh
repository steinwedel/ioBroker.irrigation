#!/usr/bin/env bash
#
# Baut die aktuelle Adapter-Version, überträgt sie auf den Zielserver und
# installiert/aktiviert sie dort. Automatisiert den in
# docs/build and install tarball.md beschriebenen Update-Ablauf.
#
# Voraussetzungen:
#   - .env im Projekt-Root mit SERVER_HOST, SERVER_USER, SERVER_PORT und
#     entweder SERVER_SSH_KEY_PATH oder SERVER_PASSWORD (siehe .env.example
#     falls vorhanden, oder die Kommentare in .env selbst)
#   - sshpass installiert, falls SERVER_PASSWORD statt SSH-Key verwendet wird
#     (macOS: brew install sshpass)
#
# Verwendung:
#   ./scripts/deploy.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "Fehler: $ENV_FILE nicht gefunden. Bitte .env mit Server-Zugangsdaten anlegen." >&2
    exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

: "${SERVER_HOST:?SERVER_HOST muss in .env gesetzt sein}"
: "${SERVER_USER:?SERVER_USER muss in .env gesetzt sein}"
SERVER_PORT="${SERVER_PORT:-22}"
IOBROKER_PATH="${IOBROKER_PATH:-/opt/iobroker}"
IRRIGATION_INSTANCE="${IRRIGATION_INSTANCE:-0}"

if [[ -z "${SERVER_SSH_KEY_PATH:-}" && -z "${SERVER_PASSWORD:-}" ]]; then
    echo "Fehler: Entweder SERVER_SSH_KEY_PATH oder SERVER_PASSWORD muss in .env gesetzt sein." >&2
    exit 1
fi

# sudo -u iobroker auf dem Server braucht ein Passwort (per "sudo -S" über STDIN
# übergeben), da /opt/iobroker dem iobroker-User gehört. SERVER_SUDO_PASSWORD
# erlaubt ein eigenes sudo-Passwort, falls es vom SSH-Login-Passwort abweicht;
# ansonsten wird SERVER_PASSWORD wiederverwendet.
SUDO_PASSWORD="${SERVER_SUDO_PASSWORD:-${SERVER_PASSWORD:-}}"
if [[ -z "$SUDO_PASSWORD" ]]; then
    echo "Fehler: SERVER_SUDO_PASSWORD oder SERVER_PASSWORD muss in .env gesetzt sein (für 'sudo -u iobroker')." >&2
    exit 1
fi

# SSH/SCP-Basisoptionen zusammenstellen
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -p "$SERVER_PORT")
SCP_OPTS=(-o StrictHostKeyChecking=accept-new -P "$SERVER_PORT")

if [[ -n "${SERVER_SSH_KEY_PATH:-}" ]]; then
    SSH_OPTS+=(-i "$SERVER_SSH_KEY_PATH")
    SCP_OPTS+=(-i "$SERVER_SSH_KEY_PATH")
    SSH_CMD=(ssh "${SSH_OPTS[@]}")
    SCP_CMD=(scp "${SCP_OPTS[@]}")
else
    if ! command -v sshpass >/dev/null 2>&1; then
        echo "Fehler: sshpass ist nicht installiert (benötigt für SERVER_PASSWORD-Login)." >&2
        echo "macOS: brew install sshpass" >&2
        exit 1
    fi
    SSH_CMD=(sshpass -p "$SERVER_PASSWORD" ssh "${SSH_OPTS[@]}")
    SCP_CMD=(sshpass -p "$SERVER_PASSWORD" scp "${SCP_OPTS[@]}")
fi

echo "==> [1/6] Baue aktuelle Version (npm run build)"
(cd "$PROJECT_ROOT" && npm run build)

echo "==> [2/6] Erstelle Tarball (npm pack)"
PACK_OUTPUT="$(cd "$PROJECT_ROOT" && npm pack --json)"
TARBALL_NAME="$(echo "$PACK_OUTPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["filename"])')"
VERSION="$(cd "$PROJECT_ROOT" && node -p "require('./package.json').version")"
TARBALL_PATH="$PROJECT_ROOT/$TARBALL_NAME"

if [[ ! -f "$TARBALL_PATH" ]]; then
    echo "Fehler: Tarball $TARBALL_PATH wurde nicht erzeugt." >&2
    exit 1
fi
echo "    Version: $VERSION"
echo "    Tarball: $TARBALL_NAME"

echo "==> [3/6] Übertrage Tarball nach $SERVER_USER@$SERVER_HOST:/tmp/"
"${SCP_CMD[@]}" "$TARBALL_PATH" "$SERVER_USER@$SERVER_HOST:/tmp/$TARBALL_NAME"

echo "==> [4/6] Installiere auf dem Server (als iobroker-User)"
"${SSH_CMD[@]}" "$SERVER_USER@$SERVER_HOST" "
    set -e
    cd '$IOBROKER_PATH'
    echo '$SUDO_PASSWORD' | sudo -S -u iobroker npm install '/tmp/$TARBALL_NAME'
"

echo "==> [5/6] Synchronisiere Objekt-Datenbank (iobroker upload)"
"${SSH_CMD[@]}" "$SERVER_USER@$SERVER_HOST" "
    set -e
    cd '$IOBROKER_PATH'
    echo '$SUDO_PASSWORD' | sudo -S -u iobroker ./iobroker upload irrigation
"

echo "==> [6/6] Starte Instanz irrigation.$IRRIGATION_INSTANCE neu"
"${SSH_CMD[@]}" "$SERVER_USER@$SERVER_HOST" "
    set -e
    cd '$IOBROKER_PATH'
    echo '$SUDO_PASSWORD' | sudo -S -u iobroker ./iobroker restart irrigation.$IRRIGATION_INSTANCE
"

echo "==> Verifiziere installierte Version"
INSTALLED_VERSION="$("${SSH_CMD[@]}" "$SERVER_USER@$SERVER_HOST" "
    cd '$IOBROKER_PATH'
    echo '$SUDO_PASSWORD' | sudo -S -u iobroker ./iobroker version irrigation
" | tail -1)"

echo ""
if [[ "$INSTALLED_VERSION" == "$VERSION" ]]; then
    echo "✅ Erfolgreich aktualisiert: irrigation.$IRRIGATION_INSTANCE läuft jetzt mit Version $INSTALLED_VERSION"
else
    echo "⚠️  Warnung: erwartete Version $VERSION, Server meldet $INSTALLED_VERSION" >&2
    exit 1
fi

# Lokales Tarball wieder aufräumen
rm -f "$TARBALL_PATH"
