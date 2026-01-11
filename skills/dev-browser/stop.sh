#!/bin/bash
PIDFILE="$HOME/.dev-browser/relay.pid"

if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Stopping relay (PID $PID)..."
        kill "$PID"
        rm -f "$PIDFILE"
        echo "Relay stopped"
    else
        echo "Relay not running (stale PID file)"
        rm -f "$PIDFILE"
    fi
else
    echo "Relay not running (no PID file)"
fi
