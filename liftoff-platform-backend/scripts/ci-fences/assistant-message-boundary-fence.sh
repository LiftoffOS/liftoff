#!/usr/bin/env bash
#
# CI fence: a chat loop that assembles an assistant turn knows where one
# message ends and the next begins.
#
# A turn writes more than once. A round says what it is about to do, runs a
# tool, and a later round writes the answer. The stream renders each as it
# arrives, so on screen they are already apart -- but the string the loop
# accumulates is what gets PERSISTED, and that row is what a reload, a /share
# link, a relay to another surface and every other participant on the thread
# read afterwards. Appended with nothing between them the two run together
# mid-sentence:
#
#     ...so let me pull the rest.Here are the top 20 in r/founder this week
#
# which is how it reached people. It is invisible while the turn is live,
# because the stream looked right, and nothing fails: the row is well-formed,
# the tests pass, and only a reader notices.
#
# The rule existed in three places in this estate before it existed in this
# one. The tenant runtime joins assistant messages this way, the workforce
# service writes the separator at every text block that opens a message, and
# this repo's AI-team chat does it at the runtime's message break -- all three
# reach a person through another process that marks where a message ended.
# The two loops that run IN this process, Liftoff and the Insights Manager,
# each accumulated text without one, so their stored replies can carry the
# seam -- visible as a capital letter after a full stop, and invisible when
# the next round opens with a bold heading or a list.
#
# So: a module that accumulates assistant text across rounds must get its
# boundary from common/assistant-message-boundary.ts, which is the one place
# the size of the gap is decided for all three assistants. A new assistant
# added without it fails here rather than months later in somebody's
# transcript.
#
# Usage:
#   scripts/ci-fences/assistant-message-boundary-fence.sh [src-dir]

set -uo pipefail
SRC="${1:-src}"
HELPER="assistant-message-boundary"
failed=0

# Modules that build up an assistant turn's text across rounds. The pattern is
# the accumulation itself, which is what makes the boundary necessary.
accumulators=$(grep -rlE '^\s*(accumulatedText|assistantText|outputText)\s*\+=' "$SRC" \
  --include='*.ts' 2>/dev/null | grep -v '__tests__' | sort)

for file in $accumulators; do
  # The helper's own module and anything that only ever writes one message are
  # not in scope; scope is "accumulates across rounds", which is the grep above.
  case "$file" in
    */"$HELPER".ts) continue ;;
  esac
  if ! grep -q "$HELPER" "$file"; then
    echo "FAIL: $file accumulates assistant text across rounds but takes no boundary from common/$HELPER.ts"
    echo "      Two messages written in one turn will be persisted run together."
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo
  echo "A turn writes more than once. The stream shows the messages apart; the"
  echo "stored row is what people read afterwards, and it needs the break too."
  echo "Use openAssistantMessage() at the point a round first shows text."
  exit 1
fi

echo "assistant-message-boundary-fence: every chat loop that accumulates knows where a message ends."
exit 0
