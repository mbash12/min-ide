# Plan: Hidden Figma Engine Bridge (Min ↔ figma-linux-next)

Personal-use architecture. Min is the controller; a hidden figma-linux-next window is the Plugin API engine. No official Figma REST/MCP (rate-limited). Plugin actions reuse the UIX bridge pattern that already works.

`vendor/figma-linux-next` stays gitignored. This plan describes Min-owned code plus a small set of patches on that clone.

---


## Worktree

Implemented on branch `feat/figma-engine-bridge` in worktree:

`/mnt/Data/MINE/MIN/min-figma-engine`

The original checkout (`feat/ai-browser-playbooks`) is left untouched.

## 1. Goal

From a Figma file open in a Min tab:

1. Sidebar Design → **Connect**.
2. Min starts (or reuses) a **hidden** figma-linux-next window, opens the **same file URL**, and **runs the local dev plugin**.
3. Clicking a frame in the Min tab updates the selected node (via the Figma URL `node-id`).
4. Sidebar / AI can **export PNG**, **extract text**, **read styles/fonts** by sending that node id to the plugin running in the hidden window.

The engine window must not appear during normal use. It may appear **once** for login.

---

## 2. Non-goals

- Official Figma API / official MCP.
- Running unpublished plugins inside the Min tab (web Figma cannot Import from manifest).
- True Chromium `--headless` (Figma still needs a live BrowserWindow; we only keep it invisible).
- Shipping this as a public Min feature. GPL-2.0 on figma-linux-next stays in the ignored vendor tree.
- Multi-file / multi-plugin at v1. One connected file, one plugin socket.

---

## 3. Roles

| Surface | Role |
| --- | --- |
| Min tab (`figma.com/design/...`) | Viewer + selector. User looks and clicks. Source of `fileKey` + `node-id`. |
| Sidebar Design | Connect / status / export / extract. |
| Hidden figma-linux-next | Desktop host so a **dev plugin** can run. Executes Plugin API. |
| Local bridge (`127.0.0.1`) | Min main ↔ plugin. Same idea as UIX `:44177`. |
| AI `figma` tool | Thin wrapper over the bridge. |

Min never calls `figma.*`. The plugin does. Min never needs DOM scraping of the canvas.

```text
┌──────────────────────── Min (Electron) ─────────────────────────┐
│  Tab: figma.com          Sidebar Design         Agent           │
│       │ URL fileKey+node-id     │ Connect/Export     │ tools    │
│       └─────────────── IPC ─────┴─────────┬──────────┘          │
│                                           │                     │
│  main/figmaEngine.js  ── spawn/control ───┤                     │
│  main/figmaBridge.js  ── WS/HTTP :44178 ──┼───────────────┐     │
└───────────────────────────────────────────┼───────────────┼─────┘
                                            │               │
                    ┌───────────────────────▼───────────────▼──┐
                    │  Hidden BrowserWindow (figma-linux-next) │
                    │  same file URL, UA "Figma/<ver>"         │
                    │  ExtensionManager + local plugin         │
                    │  plugin UI: showUI({ visible: false })   │
                    └──────────────────────────────────────────┘
```

---

## 4. Why a second window

A Min tab is just `figma.com` in a webview. The Plugin API (`figma.exportAsync`, node tree, fonts) only exists inside a **plugin sandbox**. Unpublished / `Import plugin from manifest` only exists in the **desktop host**.

figma-linux-next already has that host:

- Desktop user-agent (`Figma/<version>`) so Figma treats it as the client.
- Preload `webBinding` that forwards `handlePluginMenuAction` into the Figma SPA.
- `ExtensionManager` + `savedExtensions` for local plugins.
- `WindowManager.openUrl()` / `openUrlInNewTab`.

We do **not** import that app into Min’s `main.build.js`. Two Electron apps, two `session.defaultSession`s, two build systems. Min **spawns** the vendored app as a child and talks to it over a loopback control socket.

---

## 5. Engine process (figma-linux-next patches)

Keep the clone at `vendor/figma-linux-next`. Apply a small **engine mode** behind env `MIN_FIGMA_ENGINE=1`.

### 5.1 Hidden window

`Window.ts` currently always `show()`s (constructor fallback `revealIfHidden()` after 3s, plus `handleFrontReady`). In engine mode:

- `show: false`
- `skipTaskbar: true`
- `paintWhenInitiallyHidden: true` (file + plugin still load)
- **do not** call `revealIfHidden()` / `show()` unless Min asks for login
- optional: `setPosition(-32000, -32000)` as a Wayland fallback if a compositor ignores `show: false`

Min IPC: `figmaEngine:reveal` (login) and `figmaEngine:hide` (back to invisible).

### 5.2 Control socket

Listen on `127.0.0.1:44179` (or a Unix socket under `userData`). JSON request/response. Bind loopback only.

| Method | Effect |
| --- | --- |
| `status` | `{ authed, currentUrl, pluginReady, windowVisible }` |
| `openUrl` | `WindowManager.openUrl(url)` — same file as the Min tab |
| `runPlugin` | `app.emit("handlePluginMenuAction", windowId, menuAction)` after the file tab is focused |
| `setCookies` | write Figma cookies into the engine session |
| `hasSession` | look for `figma.session` (see `Session.ts`) |
| `show` / `hide` | login vs engine |

Wait for the file tab `setLoading(false)` (or the existing loading watchdog) before `runPlugin`. Sending the menu action too early is a no-op.

### 5.3 Local plugin registration

On engine start, if `savedExtensions` does not already include the Min bridge plugin, append it:

```text
path → <min-repo>/figma-plugin/
```

That is the same mechanism figma-linux-next uses for Import from manifest.

### 5.4 Disable extras in engine mode

- Do not start the built-in MCP server on `3845` (port noise, unused).
- Do not restore previous tabs / community tab.
- Single window.

### 5.5 Lifecycle from Min

`main/figmaEngine.js`:

1. Resolve electron binary + `vendor/figma-linux-next/dist/main/main.js` (or the system `figma-linux-next` only as a fallback; the point of the clone is patches).
2. Spawn with `MIN_FIGMA_ENGINE=1`, `MIN_FIGMA_PLUGIN=<abs path>`.
3. Wait until control socket accepts `status`.
4. Keep one child for the Min process lifetime. Connect/disconnect changes the **file URL**, not the process.
5. On Min quit, SIGTERM the child.

If the child dies, next Connect respawns it.

---

## 6. Auth

Engine session ≠ Min tab session. figma-linux-next uses `session.defaultSession`. Min tabs use `persist:webcontent` or `persist:profile-<id>`.

### Preferred: copy cookies from the Min tab

On Connect:

1. Read cookies for `https://www.figma.com` from the **same partition as the selected tab**.
2. `setCookies` on the engine (especially `figma.session` and `__Host-figma.authn`).
3. `hasSession` → `openUrl`.

If copy fails or Figma still shows login:

1. `show` the engine window.
2. User logs in there once.
3. On `hasSession === true`, `hide` again.

Do not open the system browser for `startAppAuth` while the window is hidden; login needs a visible window.

After the first successful login, cookies persist in the engine userData. Later Connects should be silent.

Engine `userData` should be a dedicated dir, e.g. `app.getPath('userData') + '/figma-engine'`, so it does not clash with a separately installed figma-linux-next.

---

## 7. Selection (Min tab → engine)

Do not scrape the canvas. Figma already puts the selection on the URL:

```text
https://www.figma.com/design/<fileKey>/<name>?node-id=12-34
```

`12-34` in the query is node `12:34` in the Plugin API.

Min already gets in-page navigations (`did-navigate-in-page` in `js/webviews.js`). Design panel / engine supervisor:

1. Parse `fileKey` from `/design/<fileKey>/` or `/file/<fileKey>/`.
2. Parse `node-id`, replace `-` → `:`.
3. Keep `{ tabId, fileKey, nodeId, url }` as the connected context.

Connect also calls engine `openUrl` with that URL so the hidden file lands on the same node when possible.

Limits (acceptable for v1):

- Multi-select is not represented cleanly in the URL; we take the URL’s node-id.
- If the user selects something that does not update the URL, Export uses the last seen node-id.

---

## 8. Plugin + bridge (from UIX)

Copy/adapt `/home/walker/Data/MINE/UIX/figma-plugin/` into Min as `figma-plugin/`. Change the product name, token, and port so it can coexist with UIX.

### Plugin

- `figma.showUI(__html__, { visible: false })` — no plugin window.
- `networkAccess.devAllowedDomains`: `http://localhost:44178`, `ws://localhost:44178`.
- Connect on load; reconnect with backoff.
- Actions (same as UIX, proven):

| action | Plugin API |
| --- | --- |
| `node-data` | CSS-ish summary, font JSON, text extract for a node |
| `find-text` | search text/name under a node |
| `export` | `exportAsync` PNG/JPG/SVG |
| `rescan` | ping / current page + selection snapshot |

Default `nodeId` if omitted: URL context from Min, else `figma.currentPage.selection[0]`.

### Bridge server (`main/figmaBridge.js`)

Loopback HTTP + WebSocket on **44178** (UIX uses 44177). Shared secret header, reject non-loopback.

- One active plugin socket.
- FIFO command queue, timeout per command.
- Binary export payload written under the workspace (e.g. `.min/design/exports/`).

Min UI and agent tools only call this server. They never talk to Figma.com.

---

## 9. Min UI and tools

### 9.1 Sidebar Design (`js/sidebar/designPanel.js`)

Replace the placeholder in `#sidebar-panel-design`.

States: **Idle** → **Connecting** → **Connected** → **Needs login** / **Plugin not ready** / **Error**.

Actions:

- **Connect** — require the selected tab URL to look like a Figma file. Spawn engine, cookie sync, `openUrl`, `runPlugin`.
- **Disconnect** — drop context; leave the engine process alive but idle.
- **Export** — bridge `export` for current `nodeId`.
- **Extract text / styles** — bridge `node-data`.

Show file name, node id, engine authed, plugin connected.

### 9.2 IPC

Renderer never spawns Electron. `js/sidebar/designPanel.js` invokes:

```text
figmaEngine:status
figmaEngine:connect     { tabId, url }
figmaEngine:disconnect
figmaEngine:revealLogin
figmaBridge:command     { action, nodeId, ... }
```

Wire `figmaEngine.js` + `figmaBridge.js` into `scripts/buildMain.js` next to `browserControl.js`.

### 9.3 Agent tools (`main/agentTools.js`)

One tool `figma` with `action`, scoped to the connected workspace (same pattern as `browser`):

- `status`
- `node-data` (`nodeId` optional → current URL node)
- `extract-text`
- `find-text` (`query`)
- `export` (`format`, `scale`)

If nothing is connected, the tool returns an error that tells the user to Connect from the Design sidebar.

---

## 10. Repo layout

```text
figma-plugin/                 # local dev plugin (in git)
  manifest.json
  code.js
  ui.html

main/figmaEngine.js           # spawn, control socket client, cookie copy
main/figmaBridge.js           # loopback WS/HTTP for the plugin
js/sidebar/designPanel.js     # Design tab UI

docs/FIGMA_ENGINE_BRIDGE_PLAN.md
vendor/figma-linux-next/      # already gitignored
patches/figma-linux-next/     # optional unified diffs for engine mode
```

Do not vendor the whole desktop app into git. Keep a short patch list (hidden window, control socket, skip MCP, register plugin path).

---

## 11. Phases

### Phase 0 — Engine mode on the clone

Patch figma-linux-next. Prove by hand:

1. `MIN_FIGMA_ENGINE=1` → no window, process stays up.
2. Control `openUrl` opens a file (verify with a temporary `show`).
3. Local plugin listed in `savedExtensions`.
4. `runPlugin` makes the plugin connect to `:44178`.

### Phase 1 — Min supervisor + Design Connect

Spawn/hide, cookie copy, login reveal, URL parse, status in the sidebar.

Success: Connect on a Figma tab → plugin socket connected, window still hidden (or shown only for login).

### Phase 2 — Read/export

Sidebar Export + extract text/styles. Write files under `.min/design/`.

### Phase 3 — Agent

`figma` tool in `createMinCustomTools()`. Same commands as the sidebar.

### Phase 4 — Harden (only if needed)

- Wayland: if `show: false` still maps a window, off-screen + `skipTaskbar`.
- Re-run plugin after Figma client updates if `handlePluginMenuAction` becomes a no-op.
- Cookie copy when the tab uses a workspace profile partition.

---

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| `revealIfHidden` shows the window | Engine mode must disable every `show()` path. |
| Plugin invoke before file ready | Wait `setLoading(false)` + short settle delay. |
| Cookie copy incomplete | Fall back to one visible login. |
| Figma changes desktop menuAction shape | Log the payload once from a visible window; pin it. |
| Two Chromium processes, RAM | One engine for the whole app, not per tab. |
| GPL-2.0 vendor | Keep clone gitignored; personal use only. |

---

## 13. Decision record

| Decision | Choice |
| --- | --- |
| Official API / MCP | No |
| Where Plugin API runs | Hidden figma-linux-next, not the Min tab |
| How Min is hosted | Child process + control socket, not in-process |
| How user picks a node | Figma URL `node-id` on the Min tab |
| How actions run | Local plugin + loopback bridge (UIX-style) |
| Window visibility | Hidden always; show only for login |
| Plugin auto-start | `handlePluginMenuAction` after the file tab is ready |
