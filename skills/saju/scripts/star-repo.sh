#!/usr/bin/env bash
# star-repo.sh — consent-gated GitHub Star helper for min9lin9/saju-agent.
#
# The target repository is hardcoded below; it is never read from remote
# content, arguments, or the environment.
#
# Consent gate (exactly one of):
#   --consent   the caller already obtained an explicit affirmative answer;
#               skip the prompt and go straight to the gh flow.
#   TTY         when BOTH stdin and stdout are terminals, ask once:
#               "min9lin9/saju-agent에 GitHub Star를 남길까요? [y/N]"
#               Only case-insensitive "y"/"yes" proceeds; anything else
#               (n, empty, EOF) prints STAR_SKIPPED and exits 0.
#   non-TTY     when either stream is not a terminal, never read or wait:
#               print STAR_CONSENT_REQUIRED + repo link, exit 0.
#
# gh flow (reached only after consent):
#   1. `command -v gh` and `gh auth status --hostname github.com`;
#      missing CLI or auth → STAR_UNAVAILABLE + repo link, exit 1.
#   2. GET /user/starred/min9lin9/saju-agent (via `gh api --include`):
#      parsed HTTP 204 → STAR_ALREADY_PRESENT, exit 0.
#      parsed HTTP 404 → PUT the same endpoint (empty body).
#   3. PUT must return 204 AND a follow-up GET must return 204 →
#      STAR_ADDED, exit 0. Any other status, 401/403, a network error, or
#      an unconfirmed write → STAR_FAILED, exit 1. No retries, and success
#      is never claimed without the confirming GET.
#
# Exit codes: 0 = added / already present / skipped / consent required;
#             1 = gh unavailable or star attempt failed;
#             2 = unknown arguments.
set -u

REPO="min9lin9/saju-agent"
REPO_URL="https://github.com/$REPO"
STARRED_ENDPOINT="/user/starred/$REPO"

usage() {
  printf 'usage: %s [--consent]\n' "${0##*/}" >&2
}

# --- arguments ---------------------------------------------------------------
CONSENT=no
for arg in "$@"; do
  case "$arg" in
    --consent) CONSENT=yes ;;
    *) usage; exit 2 ;;
  esac
done

# --- consent gate ------------------------------------------------------------
if [ "$CONSENT" != yes ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    printf '%s에 GitHub Star를 남길까요? [y/N] ' "$REPO" >&2
    reply=""
    read -r reply || true
    case "${reply,,}" in
      y|yes) ;;
      *)
        printf 'STAR_SKIPPED %s\n' "$REPO_URL"
        exit 0
        ;;
    esac
  else
    printf 'STAR_CONSENT_REQUIRED %s\n' "$REPO_URL"
    exit 0
  fi
fi

# --- gh availability ---------------------------------------------------------
if ! command -v gh >/dev/null 2>&1; then
  printf 'STAR_UNAVAILABLE %s\n' "$REPO_URL"
  printf 'star-repo: gh CLI not found on PATH\n' >&2
  exit 1
fi
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  printf 'STAR_UNAVAILABLE %s\n' "$REPO_URL"
  printf 'star-repo: gh is not authenticated for github.com\n' >&2
  exit 1
fi

# --- api calls ---------------------------------------------------------------
# gh_api prints gh's full --include output (HTTP status line, headers, body)
# on stdout; the caller parses the status code and decides. gh's own exit
# code is intentionally ignored: only the parsed HTTP status is authoritative.
gh_api() {
  gh api --hostname github.com --include --method "$1" "$STARRED_ENDPOINT" 2>&1
}

http_status() {
  printf '%s\n' "$1" | awk '/^HTTP\// { code = $2 } END { print code }'
}

GET_OUT="$(gh_api GET)"
GET_CODE="$(http_status "$GET_OUT")"

case "$GET_CODE" in
  204)
    printf 'STAR_ALREADY_PRESENT %s\n' "$REPO_URL"
    exit 0
    ;;
  404)
    PUT_OUT="$(gh_api PUT)"
    PUT_CODE="$(http_status "$PUT_OUT")"
    if [ "$PUT_CODE" != 204 ]; then
      printf '%s\n' "$PUT_OUT" >&2
      printf 'STAR_FAILED %s\n' "$REPO_URL"
      exit 1
    fi
    CONFIRM_OUT="$(gh_api GET)"
    CONFIRM_CODE="$(http_status "$CONFIRM_OUT")"
    if [ "$CONFIRM_CODE" = 204 ]; then
      printf 'STAR_ADDED %s\n' "$REPO_URL"
      exit 0
    fi
    printf '%s\n' "$CONFIRM_OUT" >&2
    printf 'STAR_FAILED %s\n' "$REPO_URL"
    exit 1
    ;;
  *)
    printf '%s\n' "$GET_OUT" >&2
    printf 'STAR_FAILED %s\n' "$REPO_URL"
    exit 1
    ;;
esac
