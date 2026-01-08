#!/bin/bash
# SessionStart hook that exposes CLAUDE_SESSION_ID to all Bash calls
# This enables dev-browser scripts to use a stable session identifier
# for page persistence across script executions.

# Read JSON input from stdin
input=$(cat)

# Extract session_id from the input JSON
# Try jq first, fall back to python if not available
if command -v jq &>/dev/null; then
    session_id=$(echo "$input" | jq -r '.session_id // empty')
else
    session_id=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null)
fi

# Write to CLAUDE_ENV_FILE if available (only set for SessionStart hooks)
if [ -n "$CLAUDE_ENV_FILE" ] && [ -n "$session_id" ]; then
    echo "export CLAUDE_SESSION_ID=\"$session_id\"" >> "$CLAUDE_ENV_FILE"
fi

# Output nothing - we don't need to inject visible context
