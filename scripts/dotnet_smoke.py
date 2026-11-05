#!/usr/bin/env python3
"""
BingoRoyale .NET API — full round lifecycle smoke test.
Boots the API, then walks the exact demo path a player + admin take:
  OTP login → wallet check → buy 2 cards → wait for the sealed draw →
  poll events → tap BINGO! (expect NOT_YET unless complete) → admin
  set-speed/set-price → completion → fairness reveal verification.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

BASE = "http://localhost:5080"
REPO = "/home/z/my-project"


def call(method: str, path: str, body: dict | None = None, cookie: str | None = None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as resp:
            set_cookie = resp.headers.get_all("Set-Cookie") or []
            out = (resp.status, json.loads(resp.read().decode()), "; ".join(c.split(";")[0] for c in set_cookie))
            LAST["status"], LAST["body"] = out[0], out[1]
            return out
    except urllib.error.HTTPError as e:
        try:
            out = (e.code, json.loads(e.read().decode()), "")
            LAST["status"], LAST["body"] = out[0], out[1]
            return out
        except Exception:
            return e.code, {}, ""


def expect(cond: bool, label: str, extra: str = ""):
    print(f"  {'PASS' if cond else 'FAIL'} — {label}" + (f" ({extra})" if extra else ""))
    if not cond:
        FAILURES.append(label)
        try:
            snapshot = json.dumps(LAST["body"])[:240]
        except Exception:
            snapshot = str(LAST["body"])[:240]
        print(f"        ↳ last response: {LAST['status']} {snapshot}")


FAILURES: list[str] = []
LAST: dict = {"status": None, "body": None}

# Deterministic run: start from a fresh PostgreSQL database. Architecture v5.0:
# "PostgreSQL 16 is the sole system of record" — the smoke run drops and
# recreates the `bingo` database so the engine replays the whole lifecycle.
import subprocess as _sp
_pg = "/tmp/pgwork/postgresql-16.4.0-x86_64-unknown-linux-gnu/bin"
_sp.run([f"{_pg}/psql", "-U", "bingo", "-h", "/tmp/pgsock", "-p", "5433", "-d", "postgres",
         "-c", "DROP DATABASE IF EXISTS bingo", "-c", "CREATE DATABASE bingo"],
        check=True, capture_output=True)
print("fresh `bingo` database created on PostgreSQL 16")

print("booting .NET API…")
env = dict(os.environ)
env["DOTNET_ROOT"] = f"{REPO}/.dotnet-sdk"
env["PATH"] = f"{env['DOTNET_ROOT']}:" + env["PATH"]
env["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
env["ASPNETCORE_URLS"] = BASE  # beat launchSettings during the smoke run
# PostgreSQL is the ONLY provider (Architecture v5.0 / ADR-03). Point Npgsql at
# the local PG16 cluster (unix-socket dir /tmp/pgsock, trust auth).
env["DATABASE_URL"] = "postgresql://bingo@127.0.0.1:5433/bingo"
log = open("/tmp/dotnet-api.log", "w")
srv = subprocess.Popen(
    [f"{REPO}/.dotnet-sdk/dotnet", f"{REPO}/dotnet/src/BingoRoyale.Api/bin/Debug/net9.0/BingoRoyale.Api.dll"],
    cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT)
try:
    deadline = time.time() + 90
    while time.time() < deadline:
        try:
            status, body, _ = call("GET", "/")
            if status == 200:
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        print("SERVER FAILED TO BOOT — log tail:")
        subprocess.run(["tail", "-30", "/tmp/dotnet-api.log"])
        sys.exit(1)
    expect(body.get("stack") == ".NET 9 / ASP.NET Core", "API is up", body.get("stack", ""))

    # ── 1. Player OTP login (UC-01 demo flow) ───────────────────────────────
    status, body, _ = call("POST", "/api/v1/auth", {"action": "request-otp", "phone": "+251911000003"})
    otp = body.get("data", {}).get("demoCode")
    expect(status == 200 and otp, "OTP issued (demo code returned)", str(otp))
    status, body, cookie = call("POST", "/api/v1/auth", {"action": "login", "phone": "+251911000003", "code": otp})
    user = body.get("data", {}).get("user", {})
    expect(status == 200 and user.get("maskedPhone", "").startswith("+251••••003"), "player logged in", user.get("maskedPhone", ""))
    status, body, _ = call("GET", "/api/v1/auth", cookie=cookie)
    expect(body.get("data", {}).get("user", {}).get("id") == user.get("id"), "GET /auth returns the session")

    # ── 2. Wallet (funded by seed: 500.00 ETB) ──────────────────────────────
    status, body, _ = call("GET", "/api/v1/wallet", cookie=cookie)
    wallet = body.get("data", {})
    base_balance = float(wallet.get("balanceDisplay", "0"))
    print(f"  wallet baseline: {base_balance:.2f} ETB")
    expect(base_balance > 0, "seeded wallet funded", wallet.get("balanceDisplay", "?"))

    # ── 3. Lobby → Golden Hall room with its sales window actually open ─────
    # (fresh DB: the first round starts ~90 s after boot, so poll until a
    #  SALES_OPEN Golden Hall round appears — the scheduler keeps them rolling.)
    room_id = None
    detail: dict = {}
    deadline = time.time() + 300
    while time.time() < deadline:
        _, lb, _ = call("GET", "/api/v1/rooms")
        golden = [r for r in lb.get("data", []) if r["title"] == "Golden Hall 75"]
        if not golden:
            print("  waiting for the rolling scheduler to create Golden Hall 75…")
            time.sleep(3)
            continue
        open_rooms = [r for r in golden if r["status"] == "SALES_OPEN"]
        room_id = (open_rooms or golden)[0]["id"]
        _, body, _ = call("GET", f"/api/v1/rooms/{room_id}")
        detail = body.get("data", {})
        if detail.get("status") == "SALES_OPEN":
            break
        time.sleep(3)
    expect(detail.get("status") == "SALES_OPEN", "room is SALES_OPEN", detail.get("status", "?"))
    expect(len(detail["prizeTable"]) == 4, "prize table has 4 tiers (Corners/X/TopLine/Blackout)")
    expect(len(detail["patterns"]) == 4, "pinned pattern shapes arrive for the UI")

    # ── 4. Purchase 2 cards (UC-03) ─────────────────────────────────────────
    key = f"smoke-{int(time.time()*1000)}"
    status, body, _ = call("POST", f"/api/v1/rooms/{room_id}/purchase", {"quantity": 2, "idempotencyKey": key}, cookie=cookie)
    purchase = body.get("data", {})
    cards = purchase.get("cards", [])
    expect(status == 200 and len(cards) == 2, "purchased 2 cards", str(purchase.get("newBalanceSantim")))
    status, body, _ = call("POST", f"/api/v1/rooms/{room_id}/purchase", {"quantity": 2, "idempotencyKey": key}, cookie=cookie)
    expect(body.get("data", {}).get("replayed") is True, "same idempotency key replays, never double-debits")

    # ── 5. Admin: OTP login + set-speed to 1s + set-price guardrail ─────────
    _, body, _ = call("POST", "/api/v1/auth", {"action": "request-otp", "phone": "+251911000001"})
    admin_otp = body["data"]["demoCode"]
    _, body, admin_cookie = call("POST", "/api/v1/auth", {"action": "login", "phone": "+251911000001", "code": admin_otp})
    status, body, _ = call("POST", f"/api/v1/admin/rounds/{room_id}", {"action": "set-speed", "speedMs": 1000}, cookie=admin_cookie)
    expect(status == 200, "admin set-speed → 1000 ms")
    status, body, _ = call("POST", f"/api/v1/admin/rounds/{room_id}", {"action": "set-price", "priceSantim": 100}, cookie=admin_cookie)
    expect(status == 200, "admin set-price → 100 santim (next round's sales)")
    status, body, _ = call("POST", f"/api/v1/admin/rounds/{room_id}", {"action": "set-speed", "speedMs": 5}, cookie=admin_cookie)
    expect(status == 400, "speed guardrail rejects 5 ms")
    status, body, _ = call("GET", f"/api/v1/admin/rounds/{room_id}", cookie=admin_cookie)
    expect(body.get("data", {}).get("seal") in (None, {}), "monitor reachable pre-LOCK (no seal yet)")

    # ── 6. Wait for the sealed draw (LOCK → DRAWING) and poll events ────────
    print("  waiting for LOCK → DRAWING (seal publishes)…")
    drawing_since = None
    last_seq = 0
    deadline = time.time() + 180
    while time.time() < deadline:
        _, body, _ = call("GET", f"/api/v1/rooms/{room_id}/events?afterSeq=0")
        d = body.get("data", {})
        last_seq = d.get("lastSeq", 0)
        if d.get("status") == "DRAWING":
            if drawing_since is None:
                drawing_since = time.time()
                print(f"  DRAWING started; ball cadence {d.get('ballIntervalMs')} ms")
            if last_seq >= 3:
                break
        time.sleep(1)
    expect(last_seq >= 3, "balls are being called", f"lastSeq={last_seq}")
    _, body, _ = call("GET", f"/api/v1/admin/rounds/{room_id}", cookie=admin_cookie)
    seal = (body.get("data", {}) or {}).get("seal") or {}
    expect(bool(seal.get("commitment")), "fairness seal commitment published at LOCK")

    # ── 7. Manual BINGO! tap with honest daubs (per-card, server truth) ─────
    _, body, _ = call("GET", f"/api/v1/rooms/{room_id}", cookie=cookie)
    my_tickets = body["data"]["myTickets"]
    _, body, _ = call("GET", f"/api/v1/rooms/{room_id}/events?afterSeq=0")
    called = {b[1] for b in body["data"]["balls"]}
    daubs = [{"ticketId": t["ticketId"], "numbers": [n for row in t["numbers"] for n in row if n is not None and n in called]}
             for t in my_tickets]
    status, body, _ = call("POST", f"/api/v1/rooms/{room_id}/claim", {"daubs": daubs}, cookie=cookie)
    claim = body.get("data", {})
    print(f"  claim outcome: {claim.get('claimed')} / {claim.get('reason')} / {claim.get('message')}")
    expect(claim.get("reason") in ("NOT_YET", None) or claim.get("claimed") is True, "claim resolves honestly (NOT_YET or win)")

    # ── 8. Round completion + fairness reveal (UC-06) ───────────────────────
    print("  waiting for round completion (75 balls @1s + grace)…")
    deadline = time.time() + 220
    final = {}
    while time.time() < deadline:
        _, body, _ = call("GET", f"/api/v1/rooms/{room_id}/events?afterSeq=0")
        final = body.get("data", {})
        if final.get("status") in ("COMPLETED", "VOIDED"):  # RESOLVING = claim grace, keep polling
            break
        time.sleep(2)
    expect(final.get("status") == "COMPLETED", "round completed", final.get("status", "?"))
    _, body, _ = call("GET", f"/api/v1/fairness/{room_id}")
    fx = body.get("data", {})
    ver = fx.get("verification") or {}
    expect(ver.get("commitmentHolds") is True, "revealed seed reproduces the exact draw against the commitment")
    seq = ver.get("drawSequence") or []
    expect(len(seq) == 75 and len(set(seq)) == 75, "revealed draw sequence is a full 75-ball permutation")
    # The published balls must equal the deterministic sequence prefix.
    _, body, _ = call("GET", f"/api/v1/rooms/{room_id}/events?afterSeq=0")
    published = [b[1] for b in body["data"]["balls"]]
    expect(published == seq[: len(published)], "every called ball matches the revealed sequence")

    # ── 9. Wallet after play + history ──────────────────────────────────────
    _, body, _ = call("GET", "/api/v1/wallet", cookie=cookie)
    hist = body.get("data", {}).get("history", [])
    kinds = [h["kind"] for h in hist]
    print(f"  wallet history kinds: {sorted(set(kinds))}, balance {body['data']['balanceDisplay']} ETB")
    expect("PURCHASE" in kinds and "DEPOSIT" in kinds,
           "journal history shows DEPOSIT + PURCHASE entries (PRIZE rows appear when a tier pays)")
    final_balance = float(body["data"]["balanceDisplay"])
    expect(abs(final_balance - (base_balance - 10.00)) < 0.001,
           "wallet balance reflects the exact double-entry debit (baseline − 2×5.00 ETB)",
           f"{base_balance:.2f} → {final_balance:.2f}")

    # ── 10. Lobby shows the round COMPLETED and next rounds rolling ─────────
    _, body, _ = call("GET", "/api/v1/rooms")
    titles = [r["title"] for r in body.get("data", [])]
    statuses = {r["title"]: r["status"] for r in body.get("data", [])}
    print(f"  lobby: {statuses}")
    expect(any(t == "Golden Hall 75" for t in titles), "rolling scheduler keeps Golden Hall rounds flowing")

finally:
    srv.terminate()
    try:
        srv.wait(timeout=10)
    except Exception:
        srv.kill()
    log.close()

print()
if FAILURES:
    print(f"SMOKE RESULT: {len(FAILURES)} FAILURE(S): {FAILURES}")
    sys.exit(1)
print("SMOKE RESULT: ALL CHECKS PASSED")
