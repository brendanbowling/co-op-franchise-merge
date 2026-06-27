# Madden NFL 26 — Offline Franchise Merge

A free Windows tool that lets **two people play the same offline Madden NFL 26 franchise at the same
time**. Normally a co-op offline dynasty is a hot-potato: one person plays, sends the file, the next
person plays, and so on. This tool removes the wait — each player plays their own game on their own
copy, and the app **merges both played games back into one shared save**.

> **Madden NFL 26 only (PC, offline franchise).** College Football 27 and Madden 27 support are
> planned once those games are out and their save formats are understood.

---

## What it does

Point it at three save files and it brings one player's played game into the shared save —
**the final score, player stats (season + career), the standings (W/L record), and the box score**
(team and per-player) — and writes a new merged save you keep playing. It never re-simulates or
double-counts; it transplants the real results.

Your three input files are **never modified** — the app only ever writes the one new merged file you
name. Everything runs on your PC; your saves never leave your machine. See
[SECURITY.md](SECURITY.md) for the full, verifiable security write-up.

---

## Install

1. Download the latest **`Madden26-Offline-Franchise-Merge-Setup-x.y.z.exe`** from the
   [Releases page](../../releases).
2. Run it. Because the app isn't code-signed, Windows SmartScreen will warn —
   click **More info → Run anyway** (this is normal for small free tools).
3. It installs per-user (no admin needed) and adds a Start-menu shortcut.

---

## How co-op simultaneous play works

One person is the **host** (keeps the shared league file; also plays). Everyone else is a **guest**.
Each week:

1. The host shares the **week's unplayed save** with everyone. *(Keep a copy of this — it's the
   "shared starting save" the merge needs.)*
2. Everyone plays **only their own game**. **Nobody advances the week.** Each person saves.
3. Guests send their saved file back to the host.
4. The host opens this app and merges (see below).
5. The host loads the merged save and **advances the week once** (the CPU games then simulate).
6. The host shares the new week's file. Repeat.

### Doing a merge in the app

The app has three file pickers:

1. **Shared starting save** — the week's file before anyone played (the copy from step 1).
2. **Your save** — the host's own played save.
3. **Partner's played save** — the file the guest sent back.

Click **Preview** to see what will be brought in, then **Merge** and choose a name for the new
merged file (e.g. `CAREER-MYLEAGUE-MERGED`). Load that file in Madden and advance the week.

> With more than two players, merge each guest's file in turn — they don't conflict because each
> person only changed their own team.

---

## Important rules

- **Play your game, but do NOT advance the week before merging.** The merge has to happen while the
  week is still unplayed; advancing first makes the engine simulate everyone else's game.
- **Save the merged file under a new name** and load *that* in Madden — don't overwrite a file the
  game currently has open.
- **Offline only.** Editing franchise saves is offline-only and against EA's online terms of
  service. Keep this tool and its output away from anything that connects to EA servers.
- Keep your own backups of important saves. (The tool never changes your inputs, but you're
  responsible for what you choose to play.)

---

## Troubleshooting

- **"No new played game found"** on Preview — the partner's save was either not played on a copy of
  the shared starting save, or the week was advanced. Re-do it without advancing.
- **SmartScreen warning** — expected (unsigned). More info → Run anyway.

---

## Building from source / running the CLI

Most people just need the installer. If you want to build it yourself or run the engine from the
command line, see [BUILDING.md](BUILDING.md). The merge/diff engine has a no-save-file self-test:
`node cli.js selftest` (expects `SELFTEST PASSED`).

---

## Disclaimer

Not affiliated with or endorsed by EA. "Madden NFL" is a trademark of its respective owner. This is
a fan-made tool for **offline** franchise saves only. Use at your own risk; always keep backups.

Built on the open-source [`madden-franchise`](https://github.com/bep713/madden-franchise) library
(bep713, MIT).
