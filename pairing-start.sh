#!/bin/sh
# Phone pairing (packages/pairing) runs beside nginx in this container, which proxies /pair/ to
# it on 127.0.0.1:3001. If it stops it starts again; nginx serves the game either way.
(
  while :; do
    node /app/packages/pairing/main.ts
    echo "Pairing server exited ($?), restarting" >&2
    sleep 1
  done
) &
