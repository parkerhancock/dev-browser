#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PIDFILE="$HOME/.dev-browser/relay.pid"
LOGFILE="$HOME/.dev-browser/relay.log"
PORT="${PORT:-9222}"
HOST="${HOST:-127.0.0.1}"

mkdir -p "$HOME/.dev-browser"

# Check if already running
if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then
        # Verify it's actually responding
        if curl -s "http://$HOST:$PORT" > /dev/null 2>&1; then
            echo "Relay already running (PID $PID, port $PORT)"
            exit 0
        fi
        # Process exists but not responding - kill it
        kill "$PID" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
fi

# Ensure dependencies installed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install --silent
fi

# Start relay daemonized
echo "Starting relay server..."
nohup npx tsx scripts/start-relay.ts > "$LOGFILE" 2>&1 &
RELAY_PID=$!
echo $RELAY_PID > "$PIDFILE"

# Wait for ready
for i in {1..30}; do
    if curl -s "http://$HOST:$PORT" > /dev/null 2>&1; then
        echo "Relay ready (PID $RELAY_PID, port $PORT)"
        exit 0
    fi
    sleep 0.5
done

echo "Error: Relay failed to start. Check $LOGFILE"
exit 1
