#!/usr/bin/env bash
# Measure Next.js dev server startup time (cold vs warm).
# Usage: bash scripts/measure-dev.sh [cold|warm]
set -u
MODE="${1:-warm}"
PORT=3100   # use a spare port so we never fight the interactive dev server
URL="http://localhost:$PORT/"

cd /home/z/my-project

# kill anything already bound to the test port
fuser -k $PORT/tcp >/dev/null 2>&1 || true
sleep 0.5

if [ "$MODE" = "cold" ]; then
  rm -rf .next
  echo "=== COLD start (no .next cache) ==="
else
  echo "=== WARM start (cached .next) ==="
fi

START=$(date +%s.%N)
bun run dev:test > /tmp/devtest.log 2>&1 &
DEVPID=$!

READY=""
for i in $(seq 1 120); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$URL" 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    READY=$(date +%s.%N)
    break
  fi
  sleep 0.5
done

if [ -z "$READY" ]; then
  echo "FAILED to become ready in 60s. Last log lines:"
  tail -20 /tmp/devtest.log
  kill $DEVPID 2>/dev/null
  exit 1
fi

echo "server-ready: $(awk "BEGIN{printf \"%.1f\", $READY - $START}")s"

# time the first full page render (lobby)
PSTART=$(date +%s.%N)
curl -s -o /dev/null --max-time 30 "$URL"
PEND=$(date +%s.%N)
echo "first-render: $(awk "BEGIN{printf \"%.1f\", $PEND - $PSTART}")s"

kill $DEVPID 2>/dev/null
wait $DEVPID 2>/dev/null
echo "=== done ($MODE) ==="
