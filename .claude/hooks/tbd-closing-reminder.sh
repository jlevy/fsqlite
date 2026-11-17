#!/bin/bash
# Remind about close protocol after git push
# Project-maintained adaptation of the hook installed by tbd setup --auto (0.10.0).
# scripts/check-project-hooks.mjs tests it; scripts/detect-git-push.mjs parses the input.

# Resolve the repository from this hook's fixed install location (.claude/hooks/ or
# .codex/), never by searching ancestors or asking git, so an enclosing directory's
# .tbd or scripts/ can never be adopted or executed.
script_path=${BASH_SOURCE[0]}
script_parent=${script_path%/*}
if [ "$script_parent" = "$script_path" ]; then
  script_parent=.
fi
if ! script_dir=$(cd -- "$script_parent" && pwd -P); then
  echo "[tbd] Cannot resolve the closing hook directory." >&2
  exit 1
fi
case "$script_dir" in
  */.claude/hooks) repo_root=${script_dir%/.claude/hooks} ;;
  */.codex) repo_root=${script_dir%/.codex} ;;
  *)
    echo "[tbd] Unexpected closing hook location: $script_dir" >&2
    exit 1
    ;;
esac
repo_root=${repo_root:-/}
if [ ! -d "$repo_root/.tbd" ]; then
  exit 0
fi
if ! is_git_push=$(node "$repo_root/scripts/detect-git-push.mjs"); then
  exit 1
fi
if [ "$is_git_push" != "yes" ]; then
  exit 0
fi
if ! cd -- "$repo_root"; then
  echo "[tbd] Cannot enter repository root: $repo_root" >&2
  exit 1
fi

tbd_configured_fallback_version() {
  local config_path=$1
  local line configured_fallback_version
  local version_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'

  while IFS= read -r line; do
    if [[ $line =~ ^tbd_fallback_version:[[:space:]]*([^[:space:]]+)[[:space:]]*$ ]]; then
      configured_fallback_version=${BASH_REMATCH[1]}
      if [[ $configured_fallback_version =~ $version_pattern ]]; then
        printf '%s\n' "$configured_fallback_version"
        return 0
      fi
      return 1
    fi
  done < "$config_path"
  return 1
}

# Run the pinned fallback under this repository's supply-chain rules. get-tbd is
# first-party, so it has no cool-off (see SUPPLY-CHAIN-SECURITY.md). npm does not read
# pnpm-workspace.yaml, so pass the no-install-scripts rule as a flag: npm's config
# precedence puts command-line flags above environment variables, so an inherited
# NPM_CONFIG_IGNORE_SCRIPTS cannot loosen it. npx keys its cache by the spec string alone,
# so a dedicated cache that only these runs fill keeps out a copy that another npx run
# fetched with install scripts or from another registry. Push detection above needs node,
# so this hook still fails closed without it.
tbd_run_fallback() {
  npx --yes --ignore-scripts --cache="${XDG_CACHE_HOME:-$HOME/.cache}/tbd-fallback-npm" "get-tbd@$configured_fallback_version" "$@"
}

tbd_print_install_hint() {
  echo "[tbd] Install it with: npm install -g --ignore-scripts get-tbd@$configured_fallback_version" >&2
}

tbd_local_can_read_repository() {
  command -v tbd &> /dev/null && tbd config get tbd_format >/dev/null 2>&1
}

# Same local-first, config-pinned fallback as tbd-session.sh, so the reminder still
# fires when tbd is not on the hook's PATH. Failures propagate instead of being hidden.
tbd_hook_path_prefix=${TBD_HOOK_PATH_PREFIX-"$HOME/.local/bin:$HOME/bin:/usr/local/bin"}
if [ -n "$tbd_hook_path_prefix" ]; then
  export PATH="$tbd_hook_path_prefix:$PATH"
fi
if tbd_local_can_read_repository; then
  tbd closing
  exit $?
fi
if ! configured_fallback_version=$(tbd_configured_fallback_version ".tbd/config.yml"); then
  echo "[tbd] .tbd/config.yml does not contain a valid exact tbd_fallback_version." >&2
  echo "[tbd] Run a current 'tbd setup --auto' to repair the managed launcher." >&2
  exit 1
fi
if command -v npx &> /dev/null; then
  if command -v tbd &> /dev/null; then
    echo "[tbd] Local tbd cannot read this repository format; using configured fallback get-tbd@$configured_fallback_version." >&2
  else
    echo "[tbd] tbd CLI not found; using configured fallback get-tbd@$configured_fallback_version." >&2
  fi
  tbd_run_fallback closing
  exit $?
fi
if command -v tbd &> /dev/null; then
  echo "[tbd] Local tbd cannot read this repository format, and npx is unavailable." >&2
else
  echo "[tbd] tbd CLI not found and npx is unavailable." >&2
fi
tbd_print_install_hint
exit 1
