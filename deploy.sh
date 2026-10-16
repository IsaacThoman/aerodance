#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

engine=${CONTAINER_ENGINE:-}
if [[ -z "$engine" ]]; then
  if command -v podman >/dev/null 2>&1; then
    engine=podman
  elif command -v docker >/dev/null 2>&1; then
    engine=docker
  else
    echo 'Install Podman or Docker with Compose before deploying.' >&2
    exit 1
  fi
fi

if ! "$engine" compose version >/dev/null 2>&1; then
  echo "Compose is unavailable for $engine. Install its Compose provider and try again." >&2
  exit 1
fi

compose=("$engine" compose -f compose.yaml -f compose.local.yaml)
echo "Rebuilding and deploying the main app locally with ${engine}…"
"${compose[@]}" build app
# Podman Compose can retain a container when only its image has changed.
# Replace the app explicitly.
"${compose[@]}" up --no-build --force-recreate -d app

echo 'Waiting for the app to become ready…'
for ((attempt = 1; attempt <= 60; attempt++)); do
  if "${compose[@]}" exec -T app wget -q -T 2 -O /dev/null http://127.0.0.1:3000/ >/dev/null 2>&1; then
    echo 'Deployment healthy. Open the local address shown below (default: http://localhost:3000).'
    "${compose[@]}" ps
    exit 0
  fi
  sleep 2
done

echo 'Deployment did not become healthy. Recent app logs:' >&2
"${compose[@]}" logs --tail=40 app >&2 || true
exit 1
