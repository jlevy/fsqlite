#!/bin/bash
# Ensure the tbd CLI is available and run `tbd prime`.
# Project-maintained adaptation of the launcher installed by tbd setup --auto (0.10.0).
# Runs on SessionStart and PreCompact. scripts/check-project-hooks.mjs tests it.
#
# Local-first when the installed CLI can read this repository's tbd_format. Otherwise,
# use the exact version recorded by setup in .tbd/config.yml. Keeping the pin in config
# avoids rewriting this script for every compatible patch while retaining deterministic
# zero-install behavior. Never use an unpinned runner here.

# Use the same caller override as the closing hook. An explicit empty value keeps PATH
# unchanged for hermetic environments.
tbd_hook_path_prefix=${TBD_HOOK_PATH_PREFIX-"$HOME/.local/bin:$HOME/bin:/usr/local/bin"}
if [ -n "$tbd_hook_path_prefix" ]; then
    export PATH="$tbd_hook_path_prefix:$PATH"
fi

# Resolve the repository from this installed script, like the closing hook, so the
# launcher works without git and from any working directory (including nested clones).
script_dir=${BASH_SOURCE[0]%/*}
if [ "$script_dir" = "${BASH_SOURCE[0]}" ]; then
    script_dir=.
fi
repo_root=
if script_root=$(cd -- "$script_dir" 2>/dev/null && pwd -P); then
    repo_root=$script_root
    while [ "$repo_root" != "/" ] && [ ! -f "$repo_root/.tbd/config.yml" ]; do
        repo_root=${repo_root%/*}
        if [ -z "$repo_root" ]; then
            repo_root=/
        fi
    done
fi
if [ -z "$repo_root" ] || [ ! -f "$repo_root/.tbd/config.yml" ]; then
    echo "[tbd] Cannot locate repository .tbd/config.yml above $script_dir." >&2
    exit 1
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

tbd_local_can_read_repository() {
    command -v tbd &> /dev/null && tbd config get tbd_format >/dev/null 2>&1
}

if tbd_local_can_read_repository; then
    # Mint this working directory's agent id once, before priming, so tbd start has an
    # identity to claim under. Idempotent, and never fatal: identity resolution falls back
    # to a derived name, and the agent should still get its briefing.
    tbd whoami --ensure-id --quiet >/dev/null 2>&1 || true
    tbd prime "$@"
    exit $?
fi

# Read and validate the exact fallback before invoking a package runner. This prevents a
# malformed or hand-edited config value from becoming an executable package spec.
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
    npx --yes "get-tbd@$configured_fallback_version" prime "$@"
    exit $?
fi

if command -v tbd &> /dev/null; then
    echo "[tbd] Local tbd cannot read this repository format, and npx is unavailable." >&2
else
    echo "[tbd] tbd CLI not found and npx is unavailable." >&2
fi
echo "[tbd] Install it with: npm install -g get-tbd@$configured_fallback_version" >&2
exit 1
