#!/usr/bin/env python3
"""Sandbox-only NuGet bootstrap: rebuild /tmp/localpkgs from nuget.org.

This sandbox rejects signed packages (NU3028/NU3042 - no certificate bundle);
LOCAL folder sources skip signature validation, so we materialize the exact
dependency closure as .nupkg files and restore with --source /tmp/localpkgs.
On a real machine you just run `dotnet restore` against nuget.org directly.
"""
import io
import json
import os
import re
import sys
import urllib.request
import zipfile

FLAT = "https://api.nuget.org/v3-flatcontainer"
OUT = "/tmp/localpkgs"
os.makedirs(OUT, exist_ok=True)

# Roots: direct PackageReferences across the three projects (net9.0).
ROOTS = [
    ("Npgsql.EntityFrameworkCore.PostgreSQL", "9.0.4"),
    ("Microsoft.AspNetCore.Authentication.JwtBearer", "9.0.0"),
    ("xunit", "2.9.2"),
    ("xunit.runner.visualstudio", "2.8.2"),
    ("Microsoft.NET.Test.Sdk", "17.12.0"),
    ("coverlet.collector", "6.0.2"),
]


def http(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "nuget-closure-bootstrap/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def all_versions(pid: str) -> list:
    return json.loads(http(f"{FLAT}/{pid.lower()}/index.json"))["versions"]


def vkey(v: str):
    core = re.split(r"[-+]", v)[0]
    return tuple(int(x) for x in re.findall(r"\d+", core)[:4])


def pick_min_satisfying(ver_list: list, lo: str) -> str | None:
    """NuGet resolves the LOWEST version satisfying the constraint; a stable
    constraint (no prerelease in the lower bound) must NOT be satisfied by a
    prerelease version even if its numeric core compares equal."""
    k = vkey(lo)
    stable_needed = "-" not in lo
    cands = [v for v in ver_list if vkey(v) >= k and not (stable_needed and "-" in v)]
    return min(cands, key=vkey) if cands else None


def lo_bound(range_str: str) -> str:
    m = re.search(r"(\d+(?:\.\d+){1,3})", range_str or "")
    return m.group(1) if m else "1.0.0"


TFM_OK = ("net9.0", "net8.0", "net7.0", "net6.0", "net5.0",
          "netcoreapp", "netstandard2.1", "netstandard2.0")


def fetch(pid: str, ver: str) -> list:
    """Download nupkg, return its dependency list [(id, minVersion)]."""
    path = f"{OUT}/{pid.lower()}.{ver}.nupkg"
    if os.path.exists(path):
        pkg = open(path, "rb").read()
    else:
        pkg = http(f"{FLAT}/{pid.lower()}/{ver}/{pid.lower()}.{ver}.nupkg")
        with open(path, "wb") as f:
            f.write(pkg)
    with zipfile.ZipFile(io.BytesIO(pkg)) as z:
        nuspec = next(n for n in z.namelist() if n.endswith(".nuspec"))
        xml = z.read(nuspec).decode("utf-8", "replace")
    deps = []
    for gm in re.finditer(r"<group[^>]*>(.*?)</group>", xml, re.S):
        group = gm.group(0)
        tfm_m = re.search(r'tfm="([^"]+)"', group)
        tfm = (tfm_m.group(1) if tfm_m else "").lower()
        if tfm and not tfm.startswith(TFM_OK):
            continue
        for d in re.finditer(r'<dependency id="([^"]+)"(?: version="([^"]+)")?', group):
            did = d.group(1)
            # Skip framework-provided / native-runtime packages the SDK owns.
            if did.lower() in ("microsoft.aspnetcore.app", "microsoft.netcore.app",
                               "netstandard.library", "microsoft.windows.desktop.app"):
                continue
            deps.append((did, lo_bound(d.group(2))))
    bare = re.sub(r"<group[^>]*>.*?</group>", "", xml, flags=re.S)
    if "<dependency" in bare:
        # Some packages (e.g. xunit) list dependencies WITHOUT a group wrapper.
        for d in re.finditer(r'<dependency id="([^"]+)"(?: version="([^"]+)")?', bare):
            did = d.group(1)
            if did.lower() in ("microsoft.aspnetcore.app", "microsoft.netcore.app",
                               "netstandard.library", "microsoft.windows.desktop.app"):
                continue
            deps.append((did, lo_bound(d.group(2))))
    return deps


def main() -> int:
    resolved: dict[str, str] = {}
    queue = list(ROOTS)
    failures: list[str] = []
    while queue:
        pid, lo = queue.pop(0)
        key = pid.lower()
        if key in resolved:
            if vkey(lo) > vkey(resolved[key]):
                # A later dependency needs a higher version: drop and re-fetch.
                old = f"{OUT}/{key}.{resolved[key]}.nupkg"
                if os.path.exists(old):
                    os.remove(old)
                del resolved[key]
                queue.append((pid, lo))
            continue
        try:
            ver = pick_min_satisfying(all_versions(pid), lo)
            if ver is None:
                failures.append(f"{pid}: no version >= {lo}")
                continue
            deps = fetch(pid, ver)
            resolved[key] = ver
            print(f"  + {pid} {ver}  ({len(deps)} deps)")
            queue.extend(deps)
        except Exception as err:  # noqa: BLE001
            failures.append(f"{pid}: {err}")
    print(f"\nCLOSURE: {len(resolved)} packages -> {OUT}")
    if failures:
        print("FAILURES:")
        for f in failures:
            print("  !", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
