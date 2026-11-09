---
description: Set up dev-browser on this machine (install its runtime and browser), or update or remove it
argument-hint: "[--service | --no-service] [--link <checkout>] [--update] [--uninstall [--purge]]"
allowed-tools: Bash
---

Run dev-browser's setup script from this plugin with the user's arguments.

1. Unless the arguments already include `--service`, `--no-service`, `--update`, or `--uninstall`, ask the user one question first: should dev-browser start automatically when they log in? If yes, add `--service`; if no, add `--no-service`.
2. Run this with the Bash tool, allowing up to 10 minutes because it downloads dependencies and a browser:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" $ARGUMENTS
   ```

3. Report what setup printed in a sentence or two: whether it succeeded, where it installed, whether the login service is on, and anything it says to do next (such as installing the Chrome extension for extension mode). If it failed, show the error and the log path it names.
