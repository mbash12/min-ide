#!/bin/sh
# Syncs the fork with minbrowser/min upstream.
#
# Usage:
#   ./scripts/upstream-sync.sh           # fetch + show what upstream added
#   ./scripts/upstream-sync.sh --merge   # fetch + merge upstream/master (no commit)
#
# After --merge, review `git status`, verify the build
# (npm run buildMain && npm run buildBrowser), then commit.
#
# Conventions that keep merges clean:
# - js/tabState/task.js stays close to upstream (FORK blocks only).
#   All workspace logic lives in js/tabState/workspace.js.
# - Fork additions to hot upstream files are marked with FORK comments.
# - core.fileMode is false; never commit mode-only changes.
set -e
cd "$(dirname "$0")/.."

git fetch upstream

if [ "$1" != "--merge" ]; then
  echo "=== upstream commits missing locally ==="
  git log --oneline HEAD..upstream/master
  echo
  echo "=== files upstream touched ==="
  git diff --stat HEAD..upstream/master | tail -10
  echo
  echo "Run with --merge to merge (no commit)."
  exit 0
fi

BASE=$(git merge-base upstream/master HEAD)
echo "merge base: $BASE"
echo "=== files BOTH sides changed (conflict candidates) ==="
git diff --name-only "$BASE"..HEAD > /tmp/fork_changed.txt
git diff --name-only "$BASE"..upstream/master > /tmp/upstream_changed.txt
grep -Fxf /tmp/fork_changed.txt /tmp/upstream_changed.txt || echo "(none - clean merge likely)"
echo
git merge upstream/master --no-edit --no-commit
echo
echo "Merged without committing. Review, build, then commit."
