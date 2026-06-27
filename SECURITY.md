# Security Audit — Madden NFL 26 Offline Franchise Merge

_Last reviewed: 2026-06-26 · App version: 0.1.0_

This document is a plain-language security audit of this tool, written so you can decide
whether you trust it **before** you download or run it. It describes exactly what the tool
does and does not do on your computer, and how to verify those claims yourself.

If you find an inaccuracy or a security issue, please open an issue on the repository.

---

## 1. What this tool is

A **self-contained Windows desktop app** for merging **Madden NFL 26 offline-franchise** saves.
You give it two copies of the same league save (one with a game you played, one with a game your
co-op partner played); it copies your partner's played game — result, player season/career stats,
standings, and box score — into a new merged save you can keep playing. It exists so two people can
play the same offline dynasty **at the same time** instead of passing one file back and forth.

It is built on the open-source `madden-franchise` library (bep713, MIT) and packaged with Electron.

> **Scope note:** This is a Madden NFL 26 tool today. College Football 27 and Madden 27 support are
> planned only after those games ship and their save formats are understood; they are not present in
> this build.

---

## 2. The one-sentence security claim

**The tool reads the save files you select plus its own bundled config, writes only the one output
file you name, makes no network connections, and changes nothing else on your computer.**

The rest of this document substantiates that claim.

---

## 3. Your files are read-only; the only thing written is the output you name

- The three saves you choose (the **shared starting save**, **your save**, **your partner's save**)
  are opened **read-only**. The merge happens on an in-memory copy and is written to a **separate
  output file** that you name in a Save dialog. Your three input files are never modified.
- The engine **refuses to run** if the output path is the same as any input file, so a merge can
  never overwrite a save you gave it (`src/applyMerge.js`).
- **No backup files, temp files, or stray copies are created.** (Earlier development builds wrote a
  `*.bak` next to your save; that was removed because the inputs are never modified, so it was
  unnecessary — see `DECISIONS.md` D6.)
- The complete list of filesystem **writes** the app can perform:
  | When | What is written | Where |
  |---|---|---|
  | You click Merge | the merged save | the exact path you choose in the Save dialog |
  | (above) | the output's parent folder, if it doesn't exist | the folder you chose |
  | CLI `snapshot`/`diff` only (not used by the GUI) | a JSON report | the `--out` path you pass |
- The complete list of filesystem **reads**: the three save files you pick, and the app's own
  bundled `config/madden26.json` + the `madden-franchise` schema files inside the app folder.

No registry keys are read or written. No files in Windows, Program Files, AppData (beyond Electron's
normal cache for its own window), or anywhere else are touched by the merge.

---

## 4. No network access — your saves never leave your machine

- **The application code makes zero network calls.** There is no HTTP/HTTPS client, no `fetch`, no
  sockets, no telemetry, no analytics, no auto-update, and no "phone home" of any kind.
- The merge engine (`src/*`) and the `madden-franchise` parsing library contain **no** `http`,
  `https`, `net`, `dns`, or socket usage (verified by source search — see §8).
- The Electron window loads **only a local file** (`renderer/index.html`) via `loadFile` — never a
  remote URL — and a strict Content-Security-Policy (`default-src 'self'`) blocks the page from
  loading or contacting anything off-disk.
- Because nothing is uploaded, **your private save files stay entirely on your computer.**

> The only URLs anywhere in the project are in `package-lock.json` — these are npm download
> addresses used **once, on a developer's machine, when building** the app. They are not contacted
> by the finished app you run.

---

## 5. No code execution or shell-out

The app never launches other programs. There is **no** `child_process`, `exec`, `spawn`, or shell
invocation anywhere in the application code or the `madden-franchise` library (verified — §8). It
parses save-file bytes in-process and writes bytes back out; that's all.

---

## 6. Electron hardening

The desktop shell is configured defensively (`main.js`):

- `contextIsolation: true` — the web page cannot reach Node.js or Electron internals.
- `nodeIntegration: false` — no `require()` / Node APIs in the page.
- `sandbox: true` — the renderer runs inside the OS sandbox.
- `webSecurity: true` + a strict **Content-Security-Policy** (`default-src 'self'`).
- The renderer talks to the Node side through a **minimal preload bridge** (`preload.js`) exposing
  exactly four actions: pick a save, pick an output path, preview, and apply. Nothing else is
  reachable from the page.
- The application menu is removed; the window only ever loads the bundled local page.

This means even though the page is Chromium-based, it cannot fetch remote content, run arbitrary
Node code, or reach your filesystem except through those four explicit, audited actions.

---

## 7. Dependencies & supply chain

- **Runtime dependency:** `madden-franchise` (MIT, pure-JavaScript save parser) and its small parsing
  sub-dependencies (bit/buffer and XML helpers used to read the game's schema). No native binaries.
- **Build-only dependencies (not shipped in the app):** `electron` (the runtime) and
  `electron-builder` (the installer packager). The HTTP-related packages you may see in
  `package-lock.json` (e.g. `got`) belong to Electron's **installer**, which only runs on the
  developer's machine to download the Electron binary; they are not part of the app you run.
- All versions are **pinned** in `package-lock.json` for reproducible builds.

---

## 8. Verify these claims yourself

You don't have to take this on faith. From the project folder:

```powershell
# 1. No network / process / shell calls in the app code:
findstr /S /I /N "http:// https:// require('net') require('http') require('https') child_process exec( spawn( fetch(" src\*.js main.js preload.js cli.js
#   -> only matches (if any) are in comments or strings, never live calls.

# 2. Every file write in the codebase (confirm they are only the chosen output / CLI --out):
findstr /S /I /N "writeFileSync copyFileSync mkdirSync createWriteStream" src\*.js main.js cli.js

# 3. Run it from source instead of the installer, if you prefer:
npm install      # restores dependencies
npm run app      # launches the GUI from source you can read
```

You can also watch the app at runtime with Windows Resource Monitor / a firewall — it should make
**no** outbound connections during a merge.

---

## 9. Known limitations & residual risks (full disclosure)

- **The installer is not code-signed.** Windows SmartScreen will show a "Windows protected your PC"
  warning; you'd click **More info → Run anyway**. This is normal for small unsigned tools (bep713's
  own Madden editor is the same). Code signing is a possible future improvement. Until then, prefer
  downloading only from the official repository release page, and verify the file hash if one is
  published.
- **It parses binary save files you provide.** A deliberately corrupted/malicious save *file* could,
  in the worst case, crash the parser. It is opened read-only and in a normal user process, but only
  open saves from sources you trust (normally your own and your co-op partner's).
- **Always keep your own backups of important saves.** The tool never modifies your inputs, but you
  are responsible for the output you choose to play.
- **Offline use only.** Editing franchise saves is offline-only and is against EA's online terms of
  service. Keep this tool and its outputs away from anything that connects to EA servers.
- The app runs as a **normal user** (no administrator elevation; the installer offers a per-user
  install). It does not need or request elevated privileges to merge saves.

---

## 10. Summary

| Question | Answer |
|---|---|
| Does it send my saves anywhere? | No. No network access at all. |
| Does it modify my original saves? | No. Inputs are read-only; only the output you name is written. |
| Does it write anywhere else on my PC? | No. No registry, no temp/backup files, no other folders. |
| Does it run other programs? | No. No shell-out / process execution. |
| Does it auto-update or track me? | No telemetry, no auto-update. |
| Is the installer signed? | Not yet — SmartScreen warning is expected (see §9). |

If anything in this document does not match what you observe, please report it on the repository.
