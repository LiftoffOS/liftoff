#!/usr/bin/env bash
#
# CI fence: this service does not say "AI team" to a customer.
#
# The product's word for the software that does the work is "agent", the word
# the rest of the ecosystem uses. "AI team" was an earlier coined noun for the
# same thing; it is ambiguous ("team" alone could mean people or software) and
# a reader arriving from anywhere else would have to translate it. This fence
# forbids it in client-facing copy and expects "agent".
#
# Why a fence exists here at all: these strings reach a
# screen: the web app maps `errorBody.error` onto ApiError.message and renders
# that message verbatim in a toast or on the page, so `{ error: 'AI team not
# found' }` is not an internal code, it is a sentence a customer reads. The
# vocabulary rule in AGENT_VOICE_BLOCK governs what the MODELS say; nothing but
# this checks the copy the service writes itself.
#
# Two rules:
#
#   1. No "AI team" in a string returned to a client. Say "agent", or "external
#      agent", or the agent's own name.
#   2. No "agent runtime" anywhere in one. That names our architecture, which the
#      confidentiality half of the voice block forbids disclosing, and a customer
#      can do nothing with it. This rule survives the rename unchanged: "agent"
#      is now the product's own word, but "agent runtime" is still the name of a
#      service, and naming a service is the thing being prevented.
#
# Scope is deliberately narrow: only `error:` / `message:` string literals, which
# is what crosses the wire. Log lines, metric labels, prompt text and test
# fixtures are none of a customer's business.
#
# Usage: scripts/ci-fences/user-facing-copy-fence.sh [dir ...]

set -uo pipefail

DIRS=("${@:-src}")

# `error:` / `message:` followed by a single-quoted literal. Interpolated
# template strings are matched too — copy assembled from a template is still
# copy, and that is exactly the shape that slipped past the web app's gate.
PATTERN="(error|message): *('[^']*'|\`[^\`]*\`)"

LITERALS=$(
  grep -rhoE "$PATTERN" "${DIRS[@]}" --include='*.ts' 2>/dev/null \
    | grep -vE '\.test\.' \
    | sort -u
)

# Rule 1: the retired noun. Both casings, singular and plural. "Microsoft Teams"
# cannot collide here because the match requires the literal words "AI team".
vocabulary=$(printf '%s\n' "$LITERALS" | grep -iE "\bAI teams?\b")

# Rule 2: the architecture. Unchanged by the rename.
architecture=$(printf '%s\n' "$LITERALS" | grep -iE "\bagent runtimes?\b")

status=0

if [ -n "$vocabulary" ]; then
  echo "FAIL: user-facing copy says \"AI team\"."
  echo
  echo "These strings reach a customer: the web app renders errorBody.error"
  echo "verbatim in toasts and on the page. Say \"agent\", \"external agent\","
  echo "or the agent's own name."
  echo
  printf '%s\n' "$vocabulary" | sed 's/^/  /'
  echo
  status=1
fi

if [ -n "$architecture" ]; then
  echo "FAIL: user-facing copy names the agent runtime."
  echo
  echo "That names our architecture, which the confidentiality rules forbid"
  echo "disclosing, and a customer can do nothing with it."
  echo
  printf '%s\n' "$architecture" | sed 's/^/  /'
  echo
  status=1
fi

if [ "$status" -ne 0 ]; then
  echo "If a string here is genuinely internal and never reaches a client,"
  echo "it does not belong in an error/message field."
  exit 1
fi

echo "PASS: no 'AI team' and no 'agent runtime' in user-facing error/message copy"
exit 0
