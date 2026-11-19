#!/bin/sh
# Codex Monitor: arranque (Linux / macOS). Requiere Python 3.
cd "$(dirname "$0")" || exit 1
PORT=8050
SRC="${CODEX_HOME:-$HOME/.codex}/sessions"

if [ ! -e codex-sessions ]; then
  [ -d "$SRC" ] || { echo "No se encuentra $SRC. Usa Codex al menos una vez y vuelve a probar."; exit 1; }
  ln -s "$SRC" codex-sessions
fi

PY=$(command -v python3 || command -v python) || {
  echo "No se ha encontrado Python 3. Instalalo con el gestor de paquetes de tu sistema"
  echo "o desde https://www.python.org/downloads/ y vuelve a probar."
  exit 1
}

URL="http://localhost:$PORT/"
echo "Codex Monitor en $URL (Ctrl+C para pararlo)"
( sleep 1
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  elif command -v open >/dev/null 2>&1; then open "$URL"; fi ) >/dev/null 2>&1 &
exec "$PY" -m http.server "$PORT" --bind 127.0.0.1
