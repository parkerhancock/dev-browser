#!/bin/bash
# Block built-in WebFetch - use the webfetch agent instead
# This hook intercepts WebFetch calls and denies them with a helpful message

cat << 'EOF'
{
  "decision": "block",
  "reason": "Built-in WebFetch is disabled. Use the webfetch agent instead: ask Claude to fetch the URL and it will route to the stealth browser-based fetcher."
}
EOF
