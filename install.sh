#!/usr/bin/env bash
# saju-agent installer — copies the saju skill into the OpenClaw workspace.
# Usage:
#   ./install.sh                      # install to ~/.openclaw/workspace/skills/saju
#   OPENCLAW_WORKSPACE=/path ./install.sh
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
DEST="$WORKSPACE/skills/saju"

echo "[saju-agent] source:    $SRC_DIR/skills/saju"
echo "[saju-agent] workspace: $WORKSPACE"

mkdir -p "$DEST"
cp -R "$SRC_DIR/skills/saju/." "$DEST/"
echo "[saju-agent] installed -> $DEST"
find "$DEST" -type f -not -path '*/node_modules/*' | sed "s|^|  |"

# 별자리(natal.mjs) 의존성: node + astronomy-engine
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  echo "[saju-agent] installing natal chart dependency (astronomy-engine)..."
  (cd "$DEST/scripts" && npm install --omit=dev --no-audit --no-fund) \
    && echo "[saju-agent] natal.mjs ready" \
    || echo "[saju-agent] npm install failed — 사주/궁합은 동작, 별자리만 불가"
else
  echo "[saju-agent] node/npm not found — 사주/궁합은 동작, 별자리(natal.mjs)는 node 필요"
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
