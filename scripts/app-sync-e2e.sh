#!/bin/bash
# Live e2e check of /app/v1 against a running backend (Postgres+Redis up):
# seed pairing code -> pair -> full pull -> incremental pull -> auth guard.
# No LLM/retrieval-model calls — rows are seeded directly via SQL.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE=${E2E_BASE_URL:-http://127.0.0.1:3000}
USER_ID="e2e-$(uuidgen | tr 'A-Z' 'a-z')"
CODE=$((RANDOM % 900000 + 100000))
SECRET="e2e-secret-$(uuidgen | tr -d '-' | head -c 40)"

psql_exec() {
  docker compose exec -T postgres psql -U postgres -d lawrag -tA -c "$1"
}

fail() { echo "E2E FAIL: $1" >&2; exit 1; }

# 1. Reverse pairing, device side: propose a code (as the app would)
PROPOSE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/app/v1/auth/pair-propose" \
  -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"deviceName\":\"e2e-runner\",\"secret\":\"$SECRET\"}")
[ "$PROPOSE" = "200" ] || fail "pair-propose returned HTTP $PROPOSE"
echo "pair-propose OK"

# 1a. Collision: re-proposing the same live code must 409, never overwrite
# the first proposal (first writer wins — the device retries fresh).
DUP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/app/v1/auth/pair-propose" \
  -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"deviceName\":\"e2e-attacker\",\"secret\":\"$SECRET\"}")
[ "$DUP" = "409" ] || fail "duplicate propose returned HTTP $DUP (expected 409)"
echo "duplicate propose rejected: 409 OK"

# 1b. Validation: malformed code must 400
BAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/app/v1/auth/pair-propose" \
  -H 'Content-Type: application/json' \
  -d '{"code":"abc","deviceName":"e2e-runner","secret":"'"$SECRET"'"}')
[ "$BAD" = "400" ] || fail "bad propose returned HTTP $BAD (expected 400)"
echo "bad propose rejected: 400 OK"

# 2. Poll before the bot claim: must read as not-claimed (no error leak).
# POST with a JSON body — the secret never travels in the URL.
PENDING=$(curl -s -X POST "$BASE/app/v1/auth/pair-status" \
  -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"secret\":\"$SECRET\"}")
echo "$PENDING" | python3 -c 'import sys,json;assert json.load(sys.stdin)=={"claimed":False}, sys.stdin.read()' || fail "pending poll mismatch: $PENDING"
echo "pending poll: claimed=false OK"

# 2b. Wrong secret must also read as not-claimed (silent)
WRONG=$(curl -s -X POST "$BASE/app/v1/auth/pair-status" \
  -H 'Content-Type: application/json' \
  -d '{"code":"'"$CODE"'","secret":"wrong-secret-000000000000000000000000"}')
echo "$WRONG" | python3 -c 'import sys,json;assert json.load(sys.stdin)=={"claimed":False}' || fail "wrong-secret poll mismatch: $WRONG"
echo "wrong-secret poll silent OK"

# NOTE: the bot claim (Telegram /pair) needs a live bot + DB user; the full
# propose -> claim -> poll(token) chain is covered by app-auth.service.spec.ts.
# For the sync checks below, mint a session directly via SQL.
TOKEN="e2e-token-$(uuidgen | tr -d '-')"
TOKEN_HASH=$(echo -n "$TOKEN" | sha256sum | awk '{print $1}')
SESSION_ID=$(psql_exec "INSERT INTO \"DeviceSession\" (id,\"userId\",\"tokenHash\",\"deviceName\",\"expiresAt\") VALUES (gen_random_uuid(),'$USER_ID','$TOKEN_HASH','e2e-runner',now() + interval '180 days') RETURNING id")
echo "session minted directly: $SESSION_ID"

# 3. Seed one row per collection
psql_exec "INSERT INTO \"UserDocument\" (id,\"userId\",\"fileName\",title,category,\"sourceHash\",\"factsCount\",summary,\"appSource\",status) VALUES (gen_random_uuid(),'$USER_ID','bescheid.pdf','E2E Bescheid','jobcenter',gen_random_uuid()::text,1,'e2e summary',true,'active')" > /dev/null
psql_exec "INSERT INTO \"UserDeadline\" (id,\"userId\",label,\"deadlineDate\",\"sourceType\") VALUES (gen_random_uuid(),'$USER_ID','Widerspruch einlegen','2026-09-30','manual')" > /dev/null
psql_exec "INSERT INTO \"UserTask\" (id,\"userId\",title,priority,\"sourceType\") VALUES (gen_random_uuid(),'$USER_ID','Nachweise einreichen','high','manual')" > /dev/null

# 4. Full pull
FULL=$(curl -s "$BASE/app/v1/sync?limit=100" -H "Authorization: Bearer $TOKEN")
echo "$FULL" | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d["documents"] and d["deadlines"] and d["tasks"], f"empty collections: {d}"
assert len(d["documents"]) == 1 and len(d["deadlines"]) == 1 and len(d["tasks"]) == 1
assert d["documents"][0]["category"] == "jobcenter"
assert d["documents"][0]["appSource"] is True
assert d["deadlines"][0]["label"] == "Widerspruch einlegen"
assert d["tasks"][0]["title"] == "Nachweise einreichen"
assert d["hasMore"] is False
assert isinstance(d["nextCursor"], str) and d["nextCursor"]
print("full pull: 1 doc / 1 deadline / 1 task OK")
' || fail "full pull payload mismatch"

# 5. Incremental pull with cursor=serverTime must be empty
CURSOR=$(echo "$FULL" | python3 -c 'import sys,json;print(json.load(sys.stdin)["nextCursor"])')
INC=$(curl -s --get "$BASE/app/v1/sync" --data-urlencode "limit=100" --data-urlencode "cursor=$CURSOR" -H "Authorization: Bearer $TOKEN")
echo "$INC" | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert not d["documents"] and not d["deadlines"] and not d["tasks"], f"cursor leaked rows: {d}"
print("incremental pull empty OK (cursor filter works)")
' || fail "cursor filter leaked rows"

# 6. Auth guard: no token must be rejected
ANON=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/app/v1/sync")
[ "$ANON" = "401" ] || [ "$ANON" = "403" ] || fail "unguarded sync returned HTTP $ANON"
echo "unauthenticated sync rejected: HTTP $ANON OK"

# 7. Bad cursor must 400
BAD=$(curl -s -o /dev/null -w '%{http_code}' --get "$BASE/app/v1/sync" --data-urlencode "cursor=not-a-date" -H "Authorization: Bearer $TOKEN")
[ "$BAD" = "400" ] || fail "invalid cursor returned HTTP $BAD (expected 400)"
echo "invalid cursor rejected: 400 OK"

# 8. Cleanup (GDPR-style sweep)
psql_exec "DELETE FROM \"UserDocument\" WHERE \"userId\" = '$USER_ID'" > /dev/null
psql_exec "DELETE FROM \"UserDeadline\" WHERE \"userId\" = '$USER_ID'" > /dev/null
psql_exec "DELETE FROM \"UserTask\" WHERE \"userId\" = '$USER_ID'" > /dev/null
psql_exec "DELETE FROM \"DeviceSession\" WHERE \"userId\" = '$USER_ID'" > /dev/null
echo "cleanup done"
echo ""
echo "E2E PASS"
