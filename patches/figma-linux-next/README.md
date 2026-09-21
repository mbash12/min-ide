# figma-linux-next engine mode patches

These patches live on the gitignored clone at `vendor/figma-linux-next`.
Re-apply them after recloning, then build:

```sh
cd vendor/figma-linux-next
bun install
bun run build
```

Keep the engine's Electron dependency installed: `figma-linux-next` v0.20.1
pins Electron 44.2.0 because Min's Electron 42 runtime can fail Figma's
`/app_auth/redeem` request. The launcher only uses Min's Electron as a last
resort when no engine or system Electron is available. NOTE: this Electron
bump (43.3.0 → 44.2.0) has not had a manual OAuth test yet — upstream warns
every Electron bump can regress `/app_auth/redeem` (see vendor CLAUDE.md).

Min launches that `dist/main/main.js` with:

- `MIN_FIGMA_ENGINE=1`
- `MIN_FIGMA_PLUGIN=<min>/figma-plugin`
- `MIN_FIGMA_CONTROL_PORT=44179`
- `MIN_FIGMA_USER_DATA=<min userData>/figma-engine`

## What changed

| File | Change |
| --- | --- |
| `src/main/engineMode.ts` | New. Hidden-window flag + loopback control HTTP (`/status`, `/rpc`). Hide is a real `win.hide()` — plugins keep running because every webPreferences sets `backgroundThrottling:false` and Chromium gets `disable-backgrounding-occluded-windows`. Show restores the saved bounds. A cold hidden connect uses one transparent, off-screen `primeWindow` activation so Figma loads its plugin runtime, then hides the window again; priming is excluded from `windowVisible` and never focuses the window. Engine watches `MIN_FIGMA_PARENT_PID` and `app.exit`s if Min dies, so it cannot orphan. `/status` reports `loading`, `currentFileKey`, and plugin-menu diagnostics (`hasPluginMenu`, `pluginMenuTabs`, `pluginMenuAgeMs`, labels, matched action). |
| `src/main/index.ts` | Engine process uses app name `min-figma-engine` and optional userData. |
| `src/main/App.ts` | Skip MCP + changelog; start control server; do not steal the `figma://` protocol from the official desktop app (guards `registerUrlHandler`, formerly `registerAppImageUrlHandler`). |
| `src/main/applyChromiumSwitches.ts` | Engine also disables occluded-window backgrounding so parked surfaces keep running. |
| `src/main/controllers/AuthController.ts` | Engine login opens a Min tab; Min intercepts `figma://` and redeems in the engine. |
| `src/renderer/DesktopAPI/webBinding.ts` | Fresh login redeems through a top-level navigation until the login page's message handler is ready. |
| `src/main/Ui/Tab.ts`, `MainTab.ts` | Intercept `figma://app_auth/redeem`. After login, keep `/files` in the same window that showed the login page; SSO popups are adopted into that window instead of becoming a second Figma chrome. |
| `src/main/Ui/WindowManager.ts` | Handle `handleAppAuthRedeem`; engine window is created real-size with `show:false`; `pluginMenuData` is cached per tab (the file tab's panel owns the dev-plugin entries); `runPluginByName` falls back to dispatching `{type:"run-local-plugin", localFileId}` straight from ExtensionManager when the SPA has not pushed its plugin menu (never-shown window) — sent to the design file tab without focusing. |
| `src/main/ExtensionManager.ts` | Register `MIN_FIGMA_PLUGIN` as a local dev extension; singleton accessor + `findLocalExtensionIdByName` for the direct `run-local-plugin` dispatch. |
| `src/main/Ui/Window.ts` | Engine window is never shown at startup (`show:false`); `focus()` is not called at startup. Visibility flag syncs from real `show`/`hide` events. The invisible prime also uses a transparent native window and CSS shield on Wayland. Close hides instead of quitting. |
| `src/main/Ui/WarmTabManager.ts` | Disabled in engine mode — a warm new-file tab creates a second CppVm and Figma errors with "Cannot create two CppVm objects". |

Copy `engineMode.ts` from this folder into `vendor/figma-linux-next/src/main/` if it is missing after a re-clone, then re-do the other file edits (or keep this clone). `min-engine.patch` is a `git diff` of all non-engineMode changes taken on top of v0.20.1 — try `git apply --3way min-engine.patch` first and only hand-edit where it conflicts.
