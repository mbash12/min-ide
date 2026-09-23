# figma-linux-next engine mode patches

These patches live on the gitignored clone at `vendor/figma-linux-next`.
After a fresh clone of v0.20.1, apply them from the Min repository root:

```sh
cp patches/figma-linux-next/engineMode.ts vendor/figma-linux-next/src/main/engineMode.ts
git -C vendor/figma-linux-next apply ../../patches/figma-linux-next/min-engine.patch
cd vendor/figma-linux-next
bun install
bun run build
```

Keep the engine's Electron dependency installed: `figma-linux-next` v0.20.1
pins Electron 44.2.0. The launcher prefers the engine's Electron, then Min's
Electron 43.4.1, then system Electron. NOTE: the upstream Electron
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
| `src/main/engineMode.ts` | Hidden window + loopback control HTTP (`/status`, `/rpc`). Each Figma renderer disables background throttling and uses `Emulation.setFocusEmulationEnabled` through Electron's in-process debugger so its page stays active without mapping the native window. `ensureRuntime` selects the requested child view and checks the editor's desktop handler. `runPlugin` waits for that handler; no `primeWindow`, transparency, off-screen positioning, or `showInactive()` is used. Status includes `backgroundRuntime`, `runtimeReady`, actual `windowVisible`, and diagnostic `everShown`. Explicit Show restores saved bounds; Hide calls `win.hide()`. The parent PID watchdog exits if Min dies. |
| `src/main/index.ts` | Engine process uses app name `min-figma-engine` and optional userData. |
| `src/main/App.ts` | Skip MCP + changelog; start control server; do not steal the `figma://` protocol from the official desktop app (guards `registerUrlHandler`, formerly `registerAppImageUrlHandler`). |
| `src/main/applyChromiumSwitches.ts` | Engine also disables occluded-window backgrounding so parked surfaces keep running. |
| `src/main/controllers/AuthController.ts` | Engine auth opens a Min tab without revealing the engine; Min intercepts `figma://` and redeems in the engine. Normal Connect copies the authenticated Min tab's cookies. |
| `src/renderer/DesktopAPI/webBinding.ts` | Exposes desktop-handler readiness for background startup. Fresh login redeems through a top-level navigation until the login page's message handler is ready. |
| `src/main/Ui/Tab.ts`, `MainTab.ts` | Intercept `figma://app_auth/redeem`. After login, keep `/files` in the same window that showed the login page; SSO popups are adopted into that window instead of becoming a second Figma chrome. |
| `src/main/Ui/WindowManager.ts` | Handle `handleAppAuthRedeem`; engine window is created real-size with `show:false`; `pluginMenuData` is cached per tab (the file tab's panel owns the dev-plugin entries); `runPluginByName` falls back to dispatching `{type:"run-local-plugin", localFileId}` straight from ExtensionManager when the SPA has not pushed its plugin menu (never-shown window) — sent to the design file tab without focusing. |
| `src/main/ExtensionManager.ts` | Register `MIN_FIGMA_PLUGIN` as a local dev extension; singleton accessor + `findLocalExtensionIdByName` for the direct `run-local-plugin` dispatch. |
| `src/main/Ui/Window.ts` | Engine window starts with `show:false`; incidental `focus()` calls cannot reveal it. Visibility syncs from real `show`/`hide` events. Close hides instead of quitting. |
| `src/main/Ui/WarmTabManager.ts` | Disabled in engine mode — a warm new-file tab creates a second CppVm and Figma errors with "Cannot create two CppVm objects". |

`min-engine.patch` contains all changes other than `engineMode.ts`, based on
v0.20.1. Rebuild after changing either source or patches. Min rejects an older
engine that does not advertise `backgroundRuntime` instead of falling back to
showing its window.

Min's plugin iframe uses `visible:false` while keeping its WebSocket alive.
The bridge drains queued HTTP commands when that socket connects, and removes
expired commands so they cannot execute after reconnecting. Connect allows up
to 150 seconds for an uncached editor/WASM download; an already loaded file
continues as soon as its desktop handler is ready. Login prompts direct the
user to the Figma tab in Min. Showing the engine remains an explicit control.

Run `npm run test:figma` from Min for the connection, hidden plugin, and real
WebSocket handoff regression tests. Check and build the engine with
`bun run check && bun run build` in the vendor directory.

Validated locally on Linux/Wayland with Electron 43.4.1: a new hidden engine
connected to an authenticated Figma file, listed frames, read node data, and
saved a 1440 × 811 PNG. Instrumented native `show`, `showInactive`, and `focus`
calls stayed at zero; status remained `windowVisible:false`, `everShown:false`.
