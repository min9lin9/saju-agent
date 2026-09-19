#!/usr/bin/env bash
# saju-agent installer — copies the saju skill into the OpenClaw workspace.
# Usage:
#   ./install.sh                      # install to ~/.openclaw/workspace/skills/saju
#   OPENCLAW_WORKSPACE=/path ./install.sh
#
# The copy is an overlay: files under skills/saju are added/replaced and
# unrelated destination files (e.g. <workspace>/saju/profiles.json) are
# preserved. node_modules is never copied — dependencies are rebuilt at the
# destination with `npm ci` from the committed package-lock.json.
#
# Feature status is verified by execution, never assumed:
#   saju-cli  node scripts/saju.mjs --input <known fixture> -> exit 0 + JSON
#   natal     node scripts/natal.mjs <birth json>           -> exit 0 + JSON
#   provider  Shinhan A027/B017 curl path (SKILL.md §3-4)   -> needs curl only
#
# Exit status: 0 when the copy succeeded and at least one feature path is
# available (READY / PARTIAL / PROVIDER-ONLY); 1 only when nothing beyond
# the copied files works (FILES-ONLY).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
DEST="$WORKSPACE/skills/saju"

echo "[saju-agent] source:    $SRC_DIR/skills/saju"
echo "[saju-agent] workspace: $WORKSPACE"

mkdir -p "$DEST"
# Overlay copy via tar with portable node_modules exclusions: GNU tar matches
# the bare name, BSD tar matches the path — cover both. Extraction preserves
# unrelated destination files.
tar --exclude='node_modules' --exclude='*/node_modules' --exclude='*/node_modules/*' \
  -C "$SRC_DIR/skills/saju" -cf - . | tar -xf - -C "$DEST"
echo "[saju-agent] files copied -> $DEST (node_modules excluded; unrelated files preserved)"
find "$DEST" -type f -not -path '*/node_modules/*' | sed "s|^|  |"

# --- feature readiness -------------------------------------------------------
# Copied files are not working features: each local capability is verified by
# running its real entry point. The Shinhan provider path needs only curl.

PROVIDER_READY=no
if command -v curl >/dev/null 2>&1; then
  PROVIDER_READY=yes
fi

SAJU_READY=no
NATAL_READY=no
if command -v node >/dev/null 2>&1; then
  if command -v npm >/dev/null 2>&1; then
    echo "[saju-agent] installing locked dependencies (npm ci: astronomy-engine, korean-lunar-calendar)..."
    if ! (cd "$DEST/scripts" && npm ci --omit=dev --no-audit --no-fund); then
      echo "[saju-agent] WARNING: npm ci failed — local features are verified below, not assumed"
    fi
  else
    echo "[saju-agent] npm not found — cannot install locked dependencies"
  fi

  VERIFY_DIR="$(mktemp -d)"
  trap 'rm -rf "$VERIFY_DIR"' EXIT

  # saju CLI readiness: run the known contract fixture when it ships with the
  # source tree, otherwise an equivalent minimal request.
  FIXTURE="$SRC_DIR/tests/fixtures/saju/requests/known.json"
  if [ ! -r "$FIXTURE" ]; then
    FIXTURE="$VERIFY_DIR/saju-verify-request.json"
    cat > "$FIXTURE" <<'JSON'
{"schemaVersion":1,"birth":{"calendar":"solar","date":"1998-10-27","time":"20:40:00","timezone":"Asia/Seoul","utcOffset":"+09:00","gender":"male"},"queries":{"majorCycles":0,"transits":[]}}
JSON
  fi
  if node "$DEST/scripts/saju.mjs" --input "$FIXTURE" > "$VERIFY_DIR/saju-out.json" 2> "$VERIFY_DIR/saju-err.log" \
    && node -e 'const fs=require("node:fs");const o=JSON.parse(fs.readFileSync(0,"utf8"));if(o.schemaVersion!==1||!o.natal||!o.provenance)process.exit(1)' < "$VERIFY_DIR/saju-out.json"; then
    SAJU_READY=yes
  else
    echo "[saju-agent] saju CLI verification failed:"
    sed 's/^/  /' "$VERIFY_DIR/saju-err.log"
  fi

  # natal readiness: separate check — the astrology CLI on a fixed input.
  if node "$DEST/scripts/natal.mjs" '{"year":1990,"month":3,"day":15,"hour":10,"minute":30,"latitude":37.5665,"longitude":126.978,"timezone":"Asia/Seoul","city":"서울"}' > "$VERIFY_DIR/natal-out.json" 2> "$VERIFY_DIR/natal-err.log" \
    && node -e 'const fs=require("node:fs");const o=JSON.parse(fs.readFileSync(0,"utf8"));if(!Array.isArray(o.planets)||o.planets.length!==10)process.exit(1)' < "$VERIFY_DIR/natal-out.json"; then
    NATAL_READY=yes
  else
    echo "[saju-agent] natal.mjs verification failed:"
    sed 's/^/  /' "$VERIFY_DIR/natal-err.log"
  fi
else
  echo "[saju-agent] node not found — local saju CLI and natal.mjs need node; provider path unaffected"
fi

# --- status summary ----------------------------------------------------------
# files copied != features available. Each line below is the verified truth.

echo "[saju-agent] feature saju-cli:  $([ "$SAJU_READY" = yes ] && echo READY || echo UNAVAILABLE) — node scripts/saju.mjs (deterministic local calculation)"
echo "[saju-agent] feature natal:     $([ "$NATAL_READY" = yes ] && echo READY || echo UNAVAILABLE) — node scripts/natal.mjs (별자리)"
if [ "$PROVIDER_READY" = yes ]; then
  echo "[saju-agent] feature provider:  AVAILABLE (shell-only) — Shinhan A027/B017 via curl per SKILL.md §3-4"
else
  echo "[saju-agent] feature provider:  UNAVAILABLE — curl not found"
fi

if [ "$SAJU_READY" = yes ] && [ "$NATAL_READY" = yes ]; then
  echo "[saju-agent] STATUS: READY — local saju calculation and natal chart verified"
elif [ "$SAJU_READY" = yes ] || [ "$NATAL_READY" = yes ]; then
  echo "[saju-agent] STATUS: PARTIAL — see feature lines above for what is unavailable"
elif [ "$PROVIDER_READY" = yes ]; then
  echo "[saju-agent] STATUS: PROVIDER-ONLY — local saju/natal unavailable; 사주/궁합은 Shinhan curl 경로로 동작 (node 설치 후 재실행하면 로컬 계산 활성화)"
else
  echo "[saju-agent] STATUS: FILES-ONLY — files copied but no feature path is available (need node+npm for local features, curl for provider)"
  exit 1
fi

# Verify the skill is discoverable
if command -v openclaw >/dev/null 2>&1; then
  echo "[saju-agent] checking 'openclaw skills list'..."
  if openclaw skills list 2>/dev/null | grep -q 'saju'; then
    echo "[saju-agent] OK — 'saju' skill is loaded."
  else
    echo "[saju-agent] skill not visible yet. Start a new session (/new) or run: openclaw gateway restart"
  fi
else
  echo "[saju-agent] 'openclaw' CLI not found on PATH — installed files only."
  echo "             On the OpenClaw host, run: openclaw skills list | grep saju"
fi

cat <<'EOF'

[saju-agent] Test it in chat:
  "1998년 10월 27일 저녁 8시생 남자, 오늘 운세 알려줘"
  "나랑 1999년 3월 15일생 여자 궁합 봐줘"
  "서울에서 태어난 내 별자리도 봐줘"
EOF
