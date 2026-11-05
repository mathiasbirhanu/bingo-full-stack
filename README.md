# Bingo Royale — Ethiopia real-money bingo platform (B2B multi-tenant)

Full stack per **Architecture v5.0**:

- **Backend:** .NET 9 (ASP.NET Core minimal API · EF Core + **Npgsql** · SignalR hub) on `:5080`
- **Frontend:** Next.js 16 + Bun + Turbopack (casino PWA) on `:3000`
- **Database:** **PostgreSQL 16 — the sole system of record** for money, rounds and audit (ADR-03). No SQLite anywhere.

## Run in VS Code (fast path)

1. **Start PostgreSQL** (compose — user `bingo`, password `bingo_dev_password`, db `bingo`, port 5432):

   ```bash
   docker compose -f infra/compose/docker-compose.yml up -d postgres
   ```

2. **Backend** (first time: `dotnet restore`):

   ```bash
   dotnet run --project dotnet/src/BingoRoyale.Api     # http://localhost:5080
   ```

   Boot order: schema + demo seed complete **before** the listener opens;
   the root JSON reports `"database":"PostgreSQL 16 (system of record)"`.

3. **Frontend**:

   ```bash
   cp .env.example .env    # PostgreSQL DSN for Prisma (compose defaults)
   bun run setup           # install + prisma generate + db push + demo seed
   bun run dev             # http://localhost:3000
   ```

4. **Or just press `F5`** — the compound launch config **“Bingo Royale: API + Web”**
   starts both processes (API with C# breakpoints + `bun run dev`).
   VS Code recommends the right extensions on open (C# Dev Kit, PostgreSQL,
   REST Client, Bun, Prisma, ESLint, Tailwind).

## Locked game rules (Build 1)

1. One ball at a time with a countdown ring — the ball shows exactly the called number.
2. Per-card daubing only — a tap never leaks to your other cards.
3. Server re-validates every claim against the called balls **on the daubed card**.
4. Wrong claim → **“NOT YET!”** + 3 s lock (server-enforced; 20 s grace after the last ball).
5. Gold glow hints show what's still missing on each card.
6. Same-ball ties split the tier; unclaimed tier prizes **roll up** the ladder (75-ball: corners @19, X @38, top line @56, blackout @75).
7. Provably fair: draw sealed at LOCK, revealed at completion — seed reproduces the exact sequence.

## Quality gates

```bash
dotnet test dotnet/src/BingoRoyale.Core.Tests   # 58/58 xUnit
bun test                                        # 57/57 contract tests
bun run lint && bunx tsc --noEmit && bunx prisma validate
python3 scripts/dotnet_smoke.py                 # end-to-end on PostgreSQL (recreates the `bingo` db)
```

## Windows notes

- Bun: `powershell -c "irm bun.sh/install.ps1 | iex"`, then restart the VS Code terminal.
- PowerShell script policy: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (or use cmd).

## Docs

- `download/Bingo_Royale_Local_Setup_Guide.md` — full step-by-step setup (DB → API → web → VS Code)
- `docs/REVIEW_GUIDE.md` — verification record + demo walk-through
- `docs/COMPLIANCE_MATRIX.md` — every SRS use case mapped to proof
- `docs/GO_LIVE_CHECKLIST.md` — demo-first → launch-ready path
- `docs/adr/` — architecture decision records
# bingo-full-stack
