#!/usr/bin/env bash
# e2e-server.sh — real end-to-end run of the agent against a local 1.18 server.
#
# Starts a vanilla 1.18 server in offline mode from the jar the loot fetcher
# already cached (assets/gamegraph/.cache/server_1.18.jar), waits for it,
# runs the bot toward GOAL, then stops the server and reports the result.
#
# Usage:
#   ./scripts/e2e-server.sh [GOAL] [MAX_STEPS]
#   ./scripts/e2e-server.sh wooden_pickaxe 60
#   ./scripts/e2e-server.sh stone_pickaxe 90
#
# The server lives in .mc-server/ (git-ignored scratch, not in the repo).
# Needs: java 17+, the cached server jar, and the project's node_modules.
# The bot runs in demo mode unless GEMINI_API_KEY or OPENAI_API_KEY is set.
set -u
cd "$(dirname "$0")/.."

GOAL="${1:-wooden_pickaxe}"
MAX_STEPS="${2:-60}"
SERVER_DIR=".mc-server"
JAR="assets/gamegraph/.cache/server_1.18.jar"

if [ ! -f "$JAR" ]; then
  echo "missing $JAR — run the bot once first (it downloads the jar for loot data)"
  exit 1
fi

mkdir -p "$SERVER_DIR"
cp -n "$JAR" "$SERVER_DIR/server_1.18.jar"
cd "$SERVER_DIR"
if [ ! -f eula.txt ]; then
  java -Xmx1G -Xms512M -jar server_1.18.jar --nogui > first-run.log 2>&1 || true
  sed -i 's/eula=false/eula=true/' eula.txt
  python3 - <<'EOF'
import re
p = 'server.properties'
s = open(p).read()
for k, v in {'online-mode': 'false', 'server-port': '61417', 'difficulty': 'peaceful',
             'spawn-protection': '0', 'gamemode': 'survival'}.items():
    s = re.sub(rf'^{k}=.*$', f'{k}={v}', s, flags=re.M)
open(p, 'w').write(s)
EOF
fi

java -Xmx1G -Xms512M -jar server_1.18.jar --nogui > server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null' EXIT

echo "waiting for server..."
for _ in $(seq 1 60); do
  grep -q 'Done (' server.log 2>/dev/null && break
  sleep 5
done
grep -q 'Done (' server.log || { echo "server did not start in time"; tail -20 server.log; exit 1; }
echo "server ready (pid $SERVER_PID)"

cd ..
GOAL="$GOAL" MAX_STEPS="$MAX_STEPS" node LLM_Minecraft/main.js 2>&1 | tee ".mc-server/bot-$GOAL.log"
BOT_EXIT=${PIPESTATUS[0]}
echo ""
if [ "$BOT_EXIT" -eq 0 ]; then
  echo "E2E PASSED: goal '$GOAL' achieved"
else
  echo "E2E FAILED: bot exited $BOT_EXIT (see .mc-server/bot-$GOAL.log)"
fi
exit "$BOT_EXIT"
