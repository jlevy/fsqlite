#!/bin/bash
# Remind about close protocol after git push
# Installed by: tbd setup --auto

if ! command=$(node -e '
  const { readFileSync } = require("node:fs")
  try {
    const input = JSON.parse(readFileSync(0, "utf8"))
    if (typeof input?.tool_input?.command === "string") {
      process.stdout.write(input.tool_input.command)
    }
  } catch {
    console.error("tbd closing reminder: invalid hook JSON")
    process.exit(1)
  }
'); then
  exit 1
fi

# Check if this is a git push command and .tbd exists
if [[ "$command" == git\ push* ]] || [[ "$command" == *"&& git push"* ]] || [[ "$command" == *"; git push"* ]]; then
  # The hook may start in a subdirectory; check .tbd at the repo root.
  repo_root=$(git rev-parse --show-toplevel 2>/dev/null) && cd "$repo_root"
  if [ -d ".tbd" ]; then
    # Same local-first, version-pinned fallback as tbd-session.sh, so the
    # reminder still fires when tbd is not on the hook's PATH.
    export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"
    if command -v tbd &> /dev/null; then
      tbd closing
    elif command -v npx &> /dev/null; then
      npx --yes get-tbd@0.4.2 closing
    fi
  fi
fi

exit 0
