#!/bin/sh
# Bring up a virtual display, then run and supervise the server.
#
# Why not xvfb-run: it waits for Xvfb to raise SIGUSR1 to signal readiness, and
# that handshake does not complete when xvfb-run is PID 1 in a container --
# Linux gives PID 1 special signal semantics. The symptom is a container that
# looks "Up" with no python process and empty logs.
set -e

DISPLAY_NUM="${DISPLAY_NUM:-99}"
XVFB_SCREEN="${XVFB_SCREEN:-1920x1080x24}"
export DISPLAY=":${DISPLAY_NUM}"

SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM}"
LOCK="/tmp/.X${DISPLAY_NUM}-lock"

# A restarted container keeps its filesystem, so the previous run's lock and
# socket are still there. Xvfb refuses to start against an existing lock, while
# the stale socket makes a naive readiness check pass -- which produced a live
# DISPLAY pointing at a dead X server, and "Missing X server or $DISPLAY" from
# every browser launch. Clear both before starting.
rm -f "$LOCK" "$SOCKET" 2>/dev/null || true

Xvfb "$DISPLAY" -screen 0 "$XVFB_SCREEN" -nolisten tcp &
XVFB_PID=$!

tries=0
while [ ! -e "$SOCKET" ]; do
    if ! kill -0 "$XVFB_PID" 2>/dev/null; then
        echo "entrypoint: Xvfb exited during startup" >&2
        exit 1
    fi
    tries=$((tries + 1))
    if [ "$tries" -gt 100 ]; then
        echo "entrypoint: Xvfb did not come up within 10s" >&2
        exit 1
    fi
    sleep 0.1
done
echo "entrypoint: Xvfb ready on ${DISPLAY} (pid ${XVFB_PID})"

# Run the app as a child rather than exec-ing it, so this script can watch the
# display. If Xvfb dies later, the server is left running with a DISPLAY that
# resolves to nothing and every session fails at browser launch; better to exit
# and let Docker's restart policy rebuild a working container.
"$@" &
APP_PID=$!

forward() { kill -TERM "$APP_PID" 2>/dev/null || true; }
trap forward TERM INT

while kill -0 "$APP_PID" 2>/dev/null; do
    if ! kill -0 "$XVFB_PID" 2>/dev/null; then
        echo "entrypoint: Xvfb died; stopping so the container restarts" >&2
        kill -TERM "$APP_PID" 2>/dev/null || true
        sleep 5
        exit 1
    fi
    sleep 2
done

wait "$APP_PID" 2>/dev/null
STATUS=$?
kill -TERM "$XVFB_PID" 2>/dev/null || true
exit "$STATUS"
