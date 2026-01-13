#!/bin/bash
# Inject CLAUDE_SESSION_ID into Bash commands
# This hook modifies the Bash tool input to prepend an export statement

set -euo pipefail

# Debug logging
exec 2>>/tmp/dev-browser-hook.log
echo "=== Hook invoked at $(date) ===" >&2

input=$(cat)
echo "Input: $input" >&2
session_id=$(echo "$input" | jq -r '.session_id // empty')
command=$(echo "$input" | jq -r '.tool_input.command // empty')

if [ -n "$session_id" ] && [ -n "$command" ]; then
  # Prepend the export to the command
  modified_command="export CLAUDE_SESSION_ID=$session_id && $command"

  # Return JSON to modify the tool input (new format)
  jq -n --arg cmd "$modified_command" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "allow",
      "updatedInput": {
        "command": $cmd
      }
    }
  }'
else
  # Pass through unchanged
  echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
fi
