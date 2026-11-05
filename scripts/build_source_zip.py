#!/usr/bin/env python3
"""Build download/BingoRoyale_Fullstack_Source.zip — clean source archive.

Root folder: BingoRoyale/. Excludes build artifacts, node_modules, runtime
databases, .env (keeps .env.example), internal working directories.
"""
import os
import zipfile

REPO = "/home/z/my-project"
OUT = os.path.join(REPO, "download", "BingoRoyale_Fullstack_Source.zip")
ROOT = "BingoRoyale"

TOP_FILES = [
    "README.md", "package.json", "bun.lock", "tsconfig.json", "next.config.ts",
    "tailwind.config.ts", "postcss.config.mjs", "eslint.config.mjs",
    "components.json", "next-env.d.ts", ".env.example", "Caddyfile",
]

SKIP_DIRS = {
    "node_modules", ".next", ".git", ".dotnet-sdk", "bin", "obj", "db",
    "download", "upload", "skills", "tool-results", ".turbo", "dist",
    "doc_text", "plan_work", "work", "bingo_docs",  # internal doc working dirs
}
SKIP_FILES = {".env", "dev.log", ".DS_Store", "db.custom.db", "custom.db"}


def skip_path(rel: str, name: str, is_dir: bool) -> bool:
    parts = rel.split(os.sep)
    if any(p in SKIP_DIRS for p in parts[:-1] if p):
        return True
    if is_dir and name in SKIP_DIRS:
        return True
    if not is_dir and (name in SKIP_FILES or name.endswith((".db", ".db-wal", ".db-shm", ".log"))):
        return True
    return False


def main() -> None:
    entries: list[tuple[str, str]] = []  # (abs path, arc name)
    # top-level files
    for f in TOP_FILES:
        p = os.path.join(REPO, f)
        if os.path.isfile(p):
            entries.append((p, f))
    # selected top dirs, walked with the skip rules
    for top in ("src", "prisma", "infra", "docs", "tests", "public", "examples",
                "mini-services", ".vscode", "scripts"):
        base = os.path.join(REPO, top)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            rel_dir = os.path.relpath(dirpath, REPO)
            for fn in filenames:
                rel = os.path.join(rel_dir, fn)
                if skip_path(rel, fn, False):
                    continue
                entries.append((os.path.join(REPO, rel), rel))
    # the dotnet solution — src trees only, never bin/obj/db
    dotnet = os.path.join(REPO, "dotnet")
    for dirpath, dirnames, filenames in os.walk(dotnet):
        dirnames[:] = [d for d in dirnames if d not in {"bin", "obj", "db", ".dotnet-sdk"}]
        rel_dir = os.path.relpath(dirpath, REPO)
        for fn in filenames:
            rel = os.path.join(rel_dir, fn)
            entries.append((os.path.join(REPO, rel), rel))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for abs_path, rel in sorted(entries, key=lambda e: e[1]):
            z.write(abs_path, os.path.join(ROOT, rel))
    total = os.path.getsize(OUT)
    print(f"zip written: {OUT}")
    print(f"files: {len(entries)}   size: {total/1024:.0f} KB")


if __name__ == "__main__":
    main()
