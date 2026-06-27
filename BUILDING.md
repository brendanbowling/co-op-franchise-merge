# Building the Windows installer

This builds the distributable `.exe` installer for the Madden NFL 26 Offline Franchise Merge app.
End users do **not** need any of this — it's for producing a release.

## Prerequisites
- **Node.js** (LTS) and npm.
- Windows 10/11 x64.

## Steps
```powershell
npm install        # installs deps incl. electron-builder (dev only)
npm run dist       # builds dist\Madden26-Offline-Franchise-Merge-Setup-<version>.exe
```
Output lands in `dist/` (git-ignored). `npm run pack` builds an unpacked app folder
(`dist/win-unpacked`) without the installer, which is handy for quick testing.

The app icon is auto-detected from `build/icon.ico` (a multi-size .ico, ≥256×256).

## One-time gotcha: winCodeSign symlink extraction (Developer Mode)
On a fresh machine, the first `npm run dist` may fail while extracting electron-builder's
`winCodeSign` helper with:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client.
  ...winCodeSign\...\darwin\10.12\lib\libcrypto.dylib
```

That archive contains **macOS symlinks**, and creating symlinks on Windows needs a privilege a
normal process lacks. Those files are macOS-only and irrelevant to a Windows build. Fix it once,
either way:

- **Recommended — enable Windows Developer Mode:** Settings → Privacy & security → For developers →
  **Developer Mode = On**. This grants symlink-creation privilege; re-run `npm run dist`.
- **Or run the build terminal as Administrator** for the first build (so the cache populates).

Once `winCodeSign` is extracted into
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`, later builds reuse the cache
and the error won't recur on this machine.

## Gotcha: keep `package.json` "description" short and ASCII-clean
electron-builder passes the package.json **`description`** into the NSIS shortcut as its comment.
A long description (or one with apostrophes / parentheses / slashes) **corrupts the icon path NSIS
writes into the Start-menu shortcut** — the app then shows a blank white icon in the taskbar and
Start search (while the `.exe` icon itself looks fine everywhere else, because only the shortcut is
broken). Keep the description to a short, plain sentence. Verify a build by checking the shortcut:
```powershell
(New-Object -ComObject WScript.Shell).CreateShortcut(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\<ProductName>.lnk").IconLocation
# should read: ...\<ProductName>\<ProductName>.exe,0   (full path to the exe, not the folder)
```

## Code signing (optional, not currently done)
Builds are **unsigned**, so Windows SmartScreen shows "Windows protected your PC → More info → Run
anyway" on first run (documented in `SECURITY.md`). To sign, provide a code-signing certificate via
electron-builder's `CSC_LINK` / `CSC_KEY_PASSWORD` env vars. We currently set
`CSC_IDENTITY_AUTO_DISCOVERY=false` so unsigned builds don't probe for a cert.

## Distribution
Publish the `Setup-<version>.exe` (and optionally its `.blockmap`) on a GitHub Release. Do **not**
commit the installer to the repo — `dist/` is git-ignored.

## Compatibility
- Target: **Windows 10 (1809+) and Windows 11, x64**. Electron 33 supports these.
- ARM64 Windows would require a separate `--arm64` build (not produced here).
