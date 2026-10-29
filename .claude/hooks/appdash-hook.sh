#!/usr/bin/env bash
# appdash - keeps this project's row in the Notion dashboard honest.
#
#   init    records the commit the session started from   (SessionStart hook)
#   check   if new commits landed since then, asks Claude
#           to update Notion before finishing              (Stop hook)
#
# The judgement of what is worth reporting lives in CLAUDE.md. This script only
# notices that commits happened and nothing was said about them - the safety net
# under the instruction, not a replacement for it.

set -uo pipefail

mode="${1:-check}"
root="${CLAUDE_PROJECT_DIR:-$PWD}"
marker="$root/.claude/.appdash-head"

cd "$root" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
head="$(git rev-parse HEAD 2>/dev/null)" || exit 0

if [ "$mode" = "init" ]; then
  printf '%s' "$head" > "$marker" 2>/dev/null
  exit 0
fi

# A blocking Stop hook runs again after Claude continues. Without this guard the
# two bounce off each other forever.
input="$(cat)"
case "${input//[[:space:]]/}" in
  *'"stop_hook_active":true'*) exit 0 ;;
esac

# No marker means SessionStart never ran, so there is nothing to compare against.
# Record and stay quiet rather than nag about commits that may predate the session.
if [ ! -f "$marker" ]; then
  printf '%s' "$head" > "$marker" 2>/dev/null
  exit 0
fi

[ "$(cat "$marker" 2>/dev/null)" = "$head" ] && exit 0

# Record before asking. If the update fails, the next Stop should not nag again.
printf '%s' "$head" > "$marker" 2>/dev/null

cat <<'JSON'
{"decision":"block","reason":"appdash: this session pushed new commits and the project's row in the Notion dashboard has not been updated. Update it now as CLAUDE.md describes under 'appdash - the Notion project dashboard', then finish. If the commits genuinely leave the project where it already stood, say so in one line and finish without updating."}
JSON
