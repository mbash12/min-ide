# Handover Audit — Blueprint vs Implementasi

> **SUPERSEDED — jangan dipakai sebagai acuan status.**
> Audit ini ditulis pada commit `b3aa644e`, **sebelum** refactor `Workspace → Task → Tab`. Digantikan oleh **[HANDOVER_GAPS.md](HANDOVER_GAPS.md)**, yang memuat gap terkini dengan bukti `file:line`.
> Bagian yang sudah tidak akurat:
> - **§1.1** — menyatakan `Workspace` adalah alias dari Task. Sekarang hierarki dua level sudah nyata (`js/tabState/workspace.js`), sehingga kesimpulan "Pinned Tasks dan AI session ownership tidak mungkin" tidak lagi berlaku.
> - **§7 Archive** — dulu tidak menghentikan AI agent; sekarang sudah (`js/browserUI.js:416-464`).
> - **§10 Profile switching** — dilaporkan IMPLEMENTED; sekarang justru membongkar semua view termasuk editor dan terminal (`js/browserUI.js:326-331`), yang bertentangan dengan blueprint.
> - **§25 AI session** — dulu ber-key `ws-<id>`; sekarang per-task (`task-<id>`, `main/agent.js:91-99`), sehingga history tidak lagi dibagi antar Task.
> - **§32 Upstream remote** — dilaporkan MISSING; sekarang `origin` = fork, `upstream` = `minbrowser/min`, `pushDefault` = `origin`.
> Nilai historisnya tetap ada sebagai catatan kondisi kode sebelum refactor.

Dokumen ini membandingkan `HANDOVER.md` (blueprint) dengan kode yang benar-benar ada di repo.

**Penting:** `HANDOVER.md` ditulis sebagai *rencana*, bukan deskripsi sistem yang sudah jadi. Beberapa keputusan struktural di blueprint tidak diimplementasikan, dan konsekuensinya ada fitur yang secara struktural belum bisa dibangun di atas fondasi saat ini.

| Metadata | Nilai |
| --- | --- |
| Tanggal audit | 2026-09-18 |
| Commit | `b3aa644e` (setelah merge ke `master`) |
| Branch | `feat/sidebar-ui-consistency` → `master` |
| Metode | Pembacaan langsung kode + verifikasi `file:line` |

---

## Ringkasan

| Area | Status |
| --- | --- |
| Favicon | IMPLEMENTED |
| Workspace model | PARTIAL — di-alias ke Task |
| Central DB | PARTIAL — JSON, bukan SQLite |
| Profiles | PARTIAL |
| Tabs / internal URL | PARTIAL — ada kebocoran path |
| Monaco | PARTIAL — tanpa autosave |
| Terminal | PARTIAL |
| Documents | PARTIAL — tanpa source mode / Mermaid |
| **Notes** | **MISSING** |
| Sidebar | IMPLEMENTED |
| File Tree | IMPLEMENTED |
| Git | IMPLEMENTED (melebihi blueprint) |
| Tile / Split View | PARTIAL — 2 panel, tidak persisten |
| Pinned Tasks | MISSING |
| Download per Task | MISSING |
| AI agent (pi.dev) | PARTIAL |
| AI session model | MOSTLY MISSING |
| Browser control | IMPLEMENTED (2 gap) |
| Settings page | PARTIAL |
| Upstream remote | MISSING |

---

## 1. Temuan struktural utama

### 1.1 Workspace adalah alias dari Task, bukan layer di atasnya

> **KOREKSI:** temuan ini sudah tidak berlaku. Setelah refactor, `Workspace` adalah store tersendiri yang memiliki satu `TaskList` per workspace (`js/tabState/workspace.js`), dan `js/tabState/task.js` kembali menjadi Task Min (tab group). Alias `const TaskList = WorkspaceList` dan shim `require('tabState/workspace.js')` di `task.js` sudah dihapus. Yang tersisa dari era ini hanyalah swap `window.tasks` dan `js/util/followTaskList.js` — lihat §31/§35 di `HANDOVER_GAPS.md`.

Ini akar dari sebagian besar penyimpangan lain.

```js
// js/tabState/workspace.js:210-213
const TaskList = WorkspaceList
module.exports.TaskList = TaskList
```

```js
// js/tabState/task.js:1
module.exports = require('tabState/workspace.js')
```

```js
// js/browserUI.js:557-563
const addWorkspace = addTask
```

Setiap mutasi juga memancarkan event ganda (`workspace-*` **dan** `task-*`) supaya konsumen bisa berlangganan ke nama mana pun (`js/tabState/workspace.js:52-55`). Jadi tidak ada dua level — hanya satu level dengan dua nama.

Konsekuensi langsung:

- Tidak ada `Workspace → Task → Tab`. Yang ada hanya `Workspace(=Task) → Tab`.
- Field `activeTaskId` tidak punya makna — sebuah task tidak punya child task.
- **Pinned Tasks (§22) tidak mungkin** tanpa menyuntikkan konsep level baru.
- **Kepemilikan AI session per Task (§25) tidak mungkin** — kunci session adalah id workspace, jadi tidak ada sesi bersama yang bisa diperebutkan antar Task.
- Semantik `Task deletion` vs `Workspace deletion` (§29/§30) runtuh jadi satu operasi yang sama.

### 1.2 Objek Workspace aktual

```js
// js/tabState/workspace.js:36-46
const newWorkspace = {
  name: workspace.name || null,
  profileId: workspace.profileId || null,
  path: workspace.path || null,
  tabs: new TabList(workspace.tabs, this),
  tabHistory: new TabStack(workspace.tabHistory),
  collapsed: workspace.collapsed,
  archived: !!workspace.archived,
  id: workspace.id || String(WorkspaceList.getRandomId()),
  selectedInWindow: workspace.selectedInWindow || null
}
```

Field blueprint yang **tidak ada**:

| Field blueprint | Realita |
| --- | --- |
| `rootPath` | Ada, tapi namanya **`path`** |
| `activeTaskId` | Tidak ada |
| `sidebarState` | Tidak ada di objek — disimpan terpisah di IndexedDB `sidebarState` keyed `workspace:<id>` (`js/sidebar.js:204-209`) |
| `activityBarVisible` | Tidak ada — hanya bagian dari `sidebar.isVisible` |
| `createdAt` | Tidak ada |
| `updatedAt` | Tidak ada — hanya `lastActivity` yang diturunkan per tab (`workspace.js:155-164`) |

### 1.3 "Central database" adalah file JSON

`CENTRALIZED_SQLITE_PLAN.md` belum dijalankan. `main/dbService.js` menulis satu file JSON secara atomik:

```js
// main/dbService.js:8, 150-158
dbFilePath = custom_app_data.db
// saveDatabase → writeFileAtomic.sync(..., JSON.stringify(...))
```

State in-memory (`main/dbService.js:23-31`):

```js
let dbState = {
  version: 1,
  user_preferences: {},
  workspace_profiles: [],
  workspace_snapshots: [],
  design_documents: [],
  documents: [],
  tab_activities: []
}
```

Dibanding daftar tabel di blueprint §12:

| Diharapkan | Status |
| --- | --- |
| `profiles` | Ada sebagai `workspace_profiles` |
| `documents` | Ada dan dipakai |
| `workspaces` | **Tidak ada** — workspace tetap di sessionRestore |
| `workspace_state` | Tidak ada |
| `task_extra_state` | Tidak ada |
| `tab_extra_metadata` | Tidak ada |
| `notes` | Tidak ada |
| `sidebar_state` | Tidak ada di DB — di Dexie `uiState` (`js/util/uiStateDB.js:44-60`) |
| `tile_state` | Tidak ada |
| AI config / provider | Tidak ada — di `settings.json` |
| `user_preferences` | Ada tapi **dead code** |
| `workspace_snapshots` | Ada tapi **dead code** — hanya ditulis sekali (`dbService.js:124-141`), tidak pernah dibaca |
| `design_documents` | Ada tapi **dead code** |
| `tab_activities` | Ada tapi **dead code** — `logTabActivity` nol pemanggil |

IPC wrapper untuk koleksi dead itu tetap ada (`dbService.js:618-648`, `js/util/customDataStore.js:52-79`) tetapi tidak ada UI yang memanggilnya.

Catatan: website storage (cookies/localStorage) **benar** tetap di Electron session partition, tidak dipindah ke DB custom. Ini sesuai §12.

---

## 2. Status per section blueprint

| § | Topik | Status |
| --- | --- | --- |
| 2 | Core hierarchy | ~~MISSING — di-alias~~ **DONE** — dua level nyata (lihat banner) |
| 3 | Favicon | **IMPLEMENTED** |
| 4 | Workspace model | **PARTIAL** |
| 5 | Workspace switching | **PARTIAL** — runtime hidup, tile tidak persisten |
| 6 | Workspace persistence | **PARTIAL** |
| 7 | Archive | **PARTIAL** — ~~AI agent tidak dihentikan~~ sudah dihentikan; sisa: auto-unpin |
| 8 | Missing workspace path | **PARTIAL** |
| 9 | Profiles | **PARTIAL** |
| 10 | Profile switching | **PARTIAL** — membongkar semua view, bukan hanya web tab |
| 11 | Clear profile data | **MISSING** |
| 12 | Central database | **PARTIAL** — JSON, bukan SQLite |
| 13 | Tabs / internal URL | **PARTIAL** — path bocor |
| 14 | Monaco | **PARTIAL** — tanpa autosave |
| 15 | Terminal | **PARTIAL** |
| 16 | Documents | **PARTIAL** |
| 17 | Notes | **MISSING** |
| 18 | Sidebar | **IMPLEMENTED** |
| 19 | File Tree | **IMPLEMENTED** |
| 20 | Git | **IMPLEMENTED** |
| 21 | Tile / Split View | **PARTIAL** |
| 22 | Pinned Tasks | **MISSING** |
| 23 | Download preference | **MISSING** |
| 24 | AI coding agent | **PARTIAL** |
| 25 | AI session model | **MOSTLY MISSING** — kini per-Task, bukan per-Workspace |
| 26 | Browser control | **IMPLEMENTED** (2 gap) |
| 27 | Settings page | **PARTIAL** |
| 28 | Startup behavior | **IMPLEMENTED** |
| 29 | Task deletion | **PARTIAL** |
| 30 | Workspace deletion | **PARTIAL** |
| 31 | Architecture guidelines | **PARTIAL** — tanpa folder `ide/` |
| 32 | Upstream compatibility | ~~MISSING — `origin` = upstream~~ **DONE** — `origin` = fork, `upstream` = minbrowser/min |
| 33 | Implementation order | Sebagian — lihat §6 |
| 34 | Non-goals | Dipatuhi |
| 35 | Working rules | n/a |
| 36 | Definition of success | Belum tercapai penuh |

---

## 3. Yang sudah solid

Bagian ini sudah bekerja dan tidak perlu dirombak.

### Favicon (§3)
`js/navbar/tabBar.js:116-138` membuat `tab-favicon-box` (favicon / globe fallback / indikator audio berbagi satu slot). `js/navbar/tabBar.js:261-282` meng-update berdasarkan `tabData.favicon.url` dan `luminance` (class `is-dark` untuk favicon gelap). Sumber data: `js/navbar/tabColor.js:186-310` menangani `page-favicon-updated`, termasuk mengabaikan favicon kosong `data:,` dan tidak mereset favicon saat navigasi SPA.

### Monaco + preview tab (§14)
Bagian yang paling sesuai blueprint.

- Monaco **0.56.0** vendored di `pages/editor/monaco/vs/` (`package.json:50`), dimuat via AMD `require(['vs/editor/editor.main'])` (`pages/editor/editor.js:200-266`), Emmet dibundel (`pages/editor/index.html:24`).
- File tree membuka file ke Monaco: `js/sidebar/fileTree.js:154-176` → `editorView.openFile(fullPath)`.
- Perilaku preview tab VS Code lengkap di `js/editorView.js`:
  - single-click membuka preview (`:129-139`)
  - klik file lain **memakai ulang** preview tab (`findPreviewTab`, `:110-127`)
  - pin saat edit (`editorBecomeDirty`, `:155-163`)
  - pin saat double-click (`js/navbar/tabBar.js:205-212`)
  - file yang sudah terbuka **di-focus**, tidak diduplikasi (`findPinnedTab`, `:103-108`)
  - scope per Task: `preview` ada di `TabList.temporaryProperties` (`js/tabState/tab.js:9`) sehingga tidak pernah ikut persisten
- File IO nyata dan dibatasi: `main/editorFileIO.js:60-74, 76-166` (cap 5 MB, blocklist ekstensi biner, containment path).

### Git sidebar (§20)
Melebihi blueprint.

- CLI git native via `spawnSync` (`main/git.js:4, 36-56`).
- Deteksi repo termasuk **subfolder**: `findGitRoot` menelusuri parent + `rev-parse --show-toplevel` (`main/git.js:58-77`).
- Lengkap: changed files, diff, stage/unstage (termasuk all), commit, branch list, checkout, pull, push, sync, conflict indicator, refresh (`main/git.js:204-501`, `js/sidebar/gitPanel.js`).
- **Ekstra:** fetch, stash/stash-pop, create/delete branch, revert, checkout-commit, dan tampilan commit graph.

### File Tree (§19)
Lengkap: expand/collapse lazy, create file/folder, rename, delete, open, refresh, context menu (`js/sidebar/fileTree.js`, `main/fileTree.js`). **Ekstra:** move, persistensi expansion per workspace, chunked rendering, guard path-escape (`main/fileTree.js:8-29`).

### Terminal (§15)
Real PTY.

- `node-pty ^1.1.0` (`package.json:52`), shell dari `$ComSpec`/`$SHELL` (`main/terminal.js:12-17`).
- Session terpisah per tab: `terminalProcesses` keyed by `webContents.id` (`main/terminal.js:10`).
- cwd default = workspace path, fallback ke `os.homedir()` (`main/terminal.js:20-29`).
- Hidup melintasi tab/task/workspace switch; mati saat tab close, task delete, archive, profile switch, window close.
- Persistence lintas restart: cwd ikut di URL tab, shell **baru** di-spawn di cwd terakhir (`main/terminal.js:41-61`) — sesuai "tidak perlu resume process".

### Sidebar (§18)
Activity bar + panel, bisa di-hide total (`js/sidebar.js:138-144`, `css/sidebar.css:19-20`). Panel **mendorong** konten, bukan overlay (`js/sidebar.js:99-123` → `webviews.adjustMargin`). Hanya satu panel aktif. State persisten per workspace dan activity terakhir kembali saat di-show ulang (`js/sidebar.js:178-221`).

### Cross-workspace browser control isolation (§26)
**Benar-benar ditegakkan**, bukan sekadar niat:

- Workspace id disuntikkan lewat closure sehingga model tidak bisa menimpanya (`main/agentTools.js:63-65`, dipanggil `main/agent.js:452`).
- Titik penegakan: `js/browserControlRenderer.js:81-111` — `resolveTab()` menolak `Tab is not in this workspace` (`:85-87`); `listTabsPayload()` hanya membaca `ws.tabs.get()` (`:69-79`); `newTab`/`closeTab`/`selectTab` memverifikasi `ws.tabs.has(tabId)` (`:137, 151`).

### Docs storage
Workspace-scoped, di DB (bukan file `.md` di disk), Markdown kanonik, WYSIWYG default (`pages/docs/docs.js:141`). URL memakai id opaque (`doc=<id>`) sehingga tidak membocorkan path filesystem (`js/docsView.js:34-39`) — satu-satunya internal surface yang benar menurut §13.

### Lazy restore (§28)
Native Min, sudah benar: restore hanya metadata (`js/sessionRestore.js:114`), view dibuat saat seleksi. Archived workspace tetap cold karena view-nya sudah dihancurkan saat archive.

---

## 4. Gap yang perlu keputusan

### 4.1 Kebocoran path di internal URL (§13) — melanggar aturan eksplisit

Blueprint §13 (`HANDOVER.md:401-419`) melarang menaruh resource nyata di URL. Editor dan terminal melanggarnya:

```js
// js/editorView.js:11-18
let url = EDITOR_BASE + '?path=' + encodeURIComponent(filePath)
if (ws && ws.path) url += '&workspace=' + encodeURIComponent(ws.path)
```

Path absolut ini tersimpan sebagai URL tab dan ditampilkan kembali di address bar lewat `urlParser.getSourceURL` (`js/util/urlParser.js:118-124`) → `tabEditor.show` (`js/navbar/tabEditor.js:30`). Terminal sama: `min://terminal?cwd=<path>` (`js/searchbar/customBangs.js:116-119`).

Perbaikan butuh sistem tab metadata (`{ tabId, kind, filePath }`) — yang juga menyelesaikan §13 soal tab `kind`.

### 4.2 Notes tidak ada sama sekali (§17)

Tidak ada collection `notes`, panel, view, page, maupun string localization. Pencarian case-insensitive untuk "notes" di `js/`, `main/`, `pages/`, `css/`, `localization/` hanya menemukan bundle Monaco dan "release notes" di `js/searchbar/updateNotifications.js`.

**Sisi baiknya:** aturan "AI tidak boleh punya akses ke Notes" (`HANDOVER.md:582, 1351`) secara teknis terpenuhi — karena tidak ada Notes untuk diakses.

### 4.3 Tab `kind` tidak ada (§13)

`TabKind` tidak eksis. Tipe tab ditebak dengan sniffing URL di tiap call site: `isEditorURL`/`isEditorTab` (`js/editorView.js:20-26`), `isDocsURL` (`js/docsView.js:15-18`), dan terminal tidak punya helper sama sekali — hanya hardcode nama page di `getInternalPageIcon` (`js/navbar/tabBar.js:18-35`).

Field tab aktual (`js/tabState/tab.js:14-33`) tidak punya `kind`/`type`.

### 4.4 Tile / split view (§21)

| Requirement | Status |
| --- | --- |
| maks 3 tabs | **Max 2** — group selalu pasangan `paneTabIds: [left, right]` (`js/splitView.js:24, 110-117`) |
| columns only | OK (`js/splitView.js:358-382`) |
| semua tipe bisa ditile | OK — tidak ada cek tipe |
| divider resizable | OK (`js/splitViewDivider.js:64-107`) |
| width persisted | **Tidak** |
| tiled relationship persisted | **Tidak** |
| association antar tab (bukan pane entity) | OK |
| satu tab hanya di satu association | OK (`js/splitView.js:99-118`) |
| auto-hapus saat tinggal satu | OK untuk kasus 2 tab (`:241-253`) |

State tile bersifat **session-only dan window-local** — dinyatakan eksplisit di komentar header `js/splitView.js:2-4`, dan di-clear saat task switch (`:431-433`). Tidak ada tabel `tile_state`. Skenario `A+B+C → A+C` di blueprint tidak bisa dimodelkan karena hanya ada pasangan.

### 4.5 AI session model (§25) — tidak bisa dibangun di atas model sekarang

| Requirement | Status |
| --- | --- |
| Session scoped ke Workspace | OK — key `'ws-' + workspaceId` (`main/agent.js:91-99`) |
| 0 atau 1 session per Task | Efektif ya (satu Map entry per workspace) |
| Satu session aktif di satu Task saja | **Tidak ada** owner field, tidak ada lock |
| Semua Task lihat history Workspace sama | **Tidak** — tiap workspace punya direktori history sendiri |
| History UI menandai owner | **Tidak** — `renderHistoryList` hanya title/time/count (`js/sidebar/agentPanel.js:388-431`) |
| Session aktif di Task lain tidak selectable | **Tidak ada logikanya** |
| Task dihapus → agent berhenti, session jadi free | **Parsial** — history tetap ada (OK), tapi agent **tidak** dihentikan |

Karena Workspace == Task (§1.1), konsep "Task A melepas Session 1 supaya Task B bisa pakai" tidak punya tempat tinggal.

### 4.6 Browser control tidak mengecualikan internal tab (§26)

Blueprint §26 (`HANDOVER.md:1004-1012`) menyatakan AI tidak perlu mengontrol Monaco / terminal / document / tile layout. Saat ini **tidak ditegakkan**:

- Satu-satunya pembatasan URL adalah settings/profiles (`main/browserControl.js:97-109`).
- Editor (`min://app/pages/editor/index.html?path=…`) dan terminal (`min://terminal?cwd=…`) adalah `WebContentsView` biasa (`main/viewManager.js:114`), jadi agent bisa `tabs`-list, `snapshot`, `click`, dan `type` di dalamnya.
- Tile layout tidak bisa diubah agent (tidak ada tool-nya) — ini kebetulan aman.

### 4.7 Terminal tidak punya pintu masuk UI

Satu-satunya cara membuat terminal tab adalah bang `!term` (`js/searchbar/customBangs.js:110-121`). Tidak ada menu, tombol navbar, atau item remote menu (`main/menu.js`, `js/navbar/addTabButton.js`, `main/remoteMenu.js` tidak memuat item terminal). Ini gap UX yang murah untuk ditutup.

### 4.8 Autosave Monaco tidak ada (§14)

Blueprint minta autosave delay 500–1000 ms. Realita:

- **Docs editor (ToastUI): ya** — debounce `setTimeout(flushSave, 500)` dengan revision tracking + flush on blur/hidden/beforeunload (`pages/docs/docs.js:54-114`).
- **Monaco: manual saja** — `saveFile` hanya dari Ctrl/Cmd+S in-page (`pages/editor/editor.js:113-141, 262`) atau menu aplikasi (`js/menuRenderer.js:94-96`). Tidak ada timer, dan memang tidak ada dirty-buffer kompleks — hanya flag `dirty` + guard `beforeunload` (`pages/editor/editor.js:279-284`).

### 4.9 Archive tidak menghentikan AI agent (§7)

`browserUI.archiveTask` (`js/browserUI.js:322-362`) melakukan: unload semua webpage (`webviews.destroy`), `splitView.clearAll()`, pertahankan DB state, switch away kalau sedang terpilih.

Tidak dilakukan:

- **Stop AI agent** — tidak ada handler archive di `main/agent.js`. Session hanya dibuang saat webContents destroyed / reconfigure (`main/agent.js:79, 284-287`).
- Unload Monaco — hanya implisit lewat view destruction.
- Stop terminal — implisit lewat `webContents` destroy (`main/terminal.js:82-84`), bekerja tapi bukan langkah archive yang disengaja.
- Auto-unpin — n/a karena Pinned Tasks tidak ada.

### 4.10 Workspace delete meninggalkan orphan Documents (§30)

`js/sidebar/docsPanel.js:510-511` hanya bind `workspace-selected`/`task-selected`; tidak ada yang mendengarkan `task-destroyed`/`workspace-destroyed`. Document menjadi row orphan di DB.

### 4.11 Profile deletion tidak diblokir saat masih dipakai (§9)

Blueprint: "Profile tidak boleh dihapus selama masih digunakan Workspace."

Realita: deletion hanya dicek terhadap konten editor yang belum disimpan, lalu workspace terdampak **diam-diam dipindah** ke default profile — `tasks.update(task.id, { profileId: null })` (`js/browserUI.js:262-316`). Bukan diblokir.

### 4.12 Clear Profile Data UI tidak ada (§11)

Tidak ada UI ala Chrome Ctrl+Shift+Delete per profile. Yang ada hanya "Clear Browsing Data" global via bang `!history` (`js/searchbar/historyViewer.js:31-42`) yang menghapus partisi webcontent bersama **dan** semua partisi profile sekaligus (`main/remoteActions.js:48-85`).

### 4.13 Download preference per Task tidak ada (§23)

Tidak ada field download dir di task/workspace. `main/download.js:54-107` hanya punya dir global sementara untuk alur AI capture. `js/downloadManager.js` hanya melacak item UI sesi (`:24, 75-82`). Tidak ada `lastDownload`/`downloadDir` di `tabState`, `uiStateDB`, atau skema DB.

### 4.14 Settings page kurang section (§27)

Ada `min://proSettings` (`js/util/proSettingsPage.js:14, 25-53`), bukan `min://settings`. Tab yang ada: **AI Provider, Profiles, Design** (`pages/proSettings/index.html:18-20`).

Blueprint minta: Profiles ✓, AI Providers ✓, Editor ✗, Terminal ✗, Workspace Defaults ✗, Documents ✗. Halaman `min://settings` bawaan Min tidak diubah sama sekali.

### 4.15 Provider hanya OpenRouter (§24)

`PROVIDER_LABELS` hanya berisi `openrouter` (`main/agent.js:30-32`), runtime key hanya di-set untuk openrouter (`main/agent.js:426`), validasi key ke `openrouter.ai/api/v1/key` (`main/agent.js:689`). Model catalog dari SDK memang membawa metadata multi-provider (`main/agent.js:706-730`) sehingga picker bisa merender banyak provider — tapi tidak ada jalur kredensial untuk provider selain OpenRouter.

API key plaintext: sesuai blueprint, tapi disimpan di `userData/settings.json` (`js/util/settings/settingsMain.js:19, 70`), bukan di DB — konsisten dengan fakta bahwa DB tidak punya tabel provider.

### 4.16 Upstream remote belum diset (§32)

Blueprint minta `origin = personal fork`, `upstream = minbrowser/min`. Realita:

```
origin  https://github.com/minbrowser/min.git (fetch)
origin  https://github.com/minbrowser/min.git (push)
```

Tidak ada remote personal fork dan tidak ada remote `upstream`. Jadi `origin` **adalah** upstream, yang berarti `origin/master` adalah branch upstream Min — menyulitkan merge upstream terperiodik dan berisiko salah push.

### 4.17 Tidak ada folder `ide/` (§31)

Blueprint menyarankan `src/ide/{workspace,profiles,persistence,sidebar,editor,terminal,documents,git,ai,browser-control}`. Repository Min tidak punya `src/`. Realita modul fork tersebar mengikuti konvensi Min:

```
main/       agent.js, agentTools.js, browserControl.js, dbService.js,
            editorFileIO.js, fileTree.js, git.js, terminal.js, playbook.js,
            figmaBridge.js, figmaEngine.js
js/sidebar/ agentPanel.js, docsPanel.js, fileTree.js, gitPanel.js,
            designPanel.js, playbookPanel.js, agentMarkdown.js, agentSlash.js, ui.js
pages/      editor/, docs/, terminal/, proSettings/, playbookTest/
js/         browserControlRenderer.js, editorView.js, docsView.js,
            splitView.js, splitViewDivider.js, sidebar.js, profiles.js
```

Blueprint sendiri membolehkan penyesuaian ("Sesuaikan dengan struktur repository Min sebenarnya"), jadi ini bukan pelanggaran — hanya catatan.

---

## 5. Fitur di luar blueprint

Sudah dibangun tetapi tidak ada di `HANDOVER.md`:

- **Playbook panel + engine** — `js/sidebar/playbookPanel.js` (449 baris), `main/playbook.js`, `pages/playbookTest/`, agent tool `playbook` (`main/agentTools.js:170`). Termasuk uji visual otomatis.
- **Design panel** — `js/sidebar/designPanel.js` (716 baris).
- **Figma engine bridge** — `main/figmaBridge.js`, `main/figmaEngine.js` (37 KB), `patches/figma-linux-next/`, agent tool `figma` (`main/agentTools.js:340`). Rencananya terdokumentasi di `docs/FIGMA_ENGINE_BRIDGE_PLAN.md`.
- **Git commit graph view** — di luar "basic VS Code Source Control".
- **AI-generated commit message** — via OpenRouter langsung (`main/git.js:344-390`).

Catatan: blueprint §34 melarang "plugin ecosystem" dan "extension marketplace", tapi Playbook/Figma bukan itu — keduanya fitur built-in. Tidak ada konflik sebenarnya.

---

## 6. Status fase (§33)

| Fase | Status | Catatan |
| --- | --- | --- |
| 1 — Foundation | **PARTIAL** | Build/run OK, favicon OK; DB masih JSON, Workspace belum jadi layer sendiri, Profile parsial |
| 2 — Workspace runtime | **PARTIAL** | Switching OK, restart restore OK, lazy restore OK; archive tidak stop AI, pinned tasks tidak ada, Clear Profile Data tidak ada |
| 3 — IDE surfaces | **HAMPIR** | Activity bar, sidebar, file tree, Monaco, terminal semua ada; terminal belum punya entry point UI |
| 4 — Development UX | **PARTIAL** | Preview tab OK, Git melebihi target; autosave Monaco belum, tile belum persisten |
| 5 — Documents | **SETENGAH** | Documents OK; source mode & Mermaid belum, Notes tidak ada |
| 6 — AI | **PARTIAL** | pi.dev OK; session ownership & history UI belum |
| 7 — Browser control | **HAMPIR** | Action lengkap, isolasi workspace ditegakkan; internal tab belum dikecualikan |

---

## 7. Definition of success (§36)

Alur di blueprint, dievaluasi satu per satu:

| Langkah | Status |
| --- | --- |
| Launch browser → Workspace 1 / Task Development aktif | OK |
| Files sidebar menunjukkan project | OK |
| Click source file → Monaco tab terbuka | OK |
| Open Terminal → shell di project root | OK (tapi hanya lewat `!term`) |
| Open local/dev website → tile Monaco \| Website \| Terminal | **Tidak** — maks 2 panel, dan tidak persisten |
| AI agent aktif di Task tersebut | OK |
| Agent edit source, jalankan command | OK |
| Agent kontrol web tab untuk testing | OK |
| Create Task lain → AI session lain paralel | Sebagian — paralel bisa, tapi ownership per Task tidak dimodelkan |
| Switch Workspace → state tetap hidup | OK |
| Return → layout & runtime sama | Runtime OK; tile hilang antar restart |
| Archive Workspace → runtime dilepas | Parsial — AI agent tetap hidup |
| Reopen → state restored lazily | Parsial — tile state tidak kembali |
| Restart browser → layout kembali, load lazy | Parsial — tab/task OK, tile tidak |

Kesimpulan: alur inti bekerja. Yang menghalangi "cukup untuk dipakai harian" adalah tile persistence dan entry point terminal.

---

## 8. Rekomendasi prioritas

Murah dan berdampak langsung:

1. **Entry point terminal di UI** — menu / tombol navbar. Terminal sudah berfungsi penuh, hanya tidak terjangkau.
2. **Persist tile state** — tambah tabel/collection `tile_state` atau simpan di Dexie `uiState` mengikuti pola `sidebarState` yang sudah ada. Hapus komentar "session-only" di `js/splitView.js:3`.
3. **Stop AI agent saat archive + saat Task/Workspace delete** — tambah handler di `main/agent.js` dan panggil dari `js/browserUI.js`.
4. **Hapus Document saat Workspace delete** — dengarkan `workspace-destroyed` di `js/sidebar/docsPanel.js`.
5. **Blokir delete Profile yang masih dipakai** — ganti silent-reassign di `js/browserUI.js:262-316` dengan penolakan + pesan.
6. **Set remote `upstream`** — `git remote add upstream https://github.com/minbrowser/min.git`, arahkan `origin` ke fork personal.
7. **Autosave Monaco** — debounce mengikuti pola `pages/docs/docs.js:54-114`.

Menengah:

8. **Sistem tab `kind` + tab metadata** — prasyarat untuk menutup kebocoran path (§4.1) dan mengecualikan internal tab dari browser control (§4.6). Satu pekerjaan menyelesaikan dua gap.
9. **Download dir per Task**.
10. **Perluas `min://proSettings`** dengan section Editor / Terminal / Workspace Defaults / Documents.
11. **Source mode + Mermaid di doc editor**.
12. **AI session ownership + history UI**.

Besar (perlu keputusan produk):

13. **Notes** — fitur utuh dari nol, dengan syarat tidak ada tool AI.
14. **Layer Workspace di atas Task** — ini perubahan arsitektural yang membuka Pinned Tasks dan AI session ownership sekaligus. Kalau tidak dikejar, §22 dan §25 sebaiknya dihapus dari blueprint supaya dokumen tidak menjanjikan sesuatu yang tidak akan ada.
15. **Tile 3 panel** dengan semantik `A+B+C → A+C`.

---

## 9. Catatan

- YANG PENTING: audit ini memverifikasi **keberadaan dan perilaku kode**, bukan kualitas runtime. Belum ada pengujian menjalankan browser.
- Beberapa file yang tampak relevan ternyata tidak berhubungan dengan fitur fork: `main/permissionManager.js` adalah permission manager website (media/notifikasi/pointer lock), bukan permission AI; `main/registryConfig.js` adalah installer registry Windows.
- Backend `CENTRALIZED_SQLITE_PLAN.md` sama statusnya dengan `HANDOVER.md`: dokumen rencana, belum dieksekusi.
