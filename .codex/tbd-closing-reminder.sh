#!/bin/bash
# Remind about close protocol after git push
# Project-maintained adaptation of the hook installed by tbd setup --auto.

# Resolve the repository from this installed hook, not from git or the caller's cwd.
script_dir=${BASH_SOURCE[0]%/*}
if [ "$script_dir" = "${BASH_SOURCE[0]}" ]; then
  script_dir=.
fi
if ! repo_root=$(cd -- "$script_dir" && pwd -P); then
  echo "[tbd] Cannot resolve the closing hook directory." >&2
  exit 1
fi
while [ "$repo_root" != "/" ] && [ ! -d "$repo_root/.tbd" ]; do
  repo_root=${repo_root%/*}
  if [ -z "$repo_root" ]; then
    repo_root=/
  fi
done
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

# Same local-first, version-pinned fallback as tbd-session.sh, so the
# reminder still fires when tbd is not on the hook's PATH.
tbd_hook_path_prefix=${TBD_HOOK_PATH_PREFIX-"$HOME/.local/bin:$HOME/bin:/usr/local/bin"}
if [ -n "$tbd_hook_path_prefix" ]; then
  export PATH="$tbd_hook_path_prefix:$PATH"
fi
if command -v tbd &> /dev/null; then
  tbd closing
  exit $?
fi
if command -v npx &> /dev/null; then
  npx --yes get-tbd@0.4.2 closing
  exit $?
fi
echo "[tbd] tbd CLI not found and npx is unavailable." >&2
echo "[tbd] Install it with: npm install -g get-tbd@0.4.2" >&2
exit 1
