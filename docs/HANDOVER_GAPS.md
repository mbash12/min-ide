# Handover Gap — Implementasi vs `HANDOVER.md`

Dokumen ini mencatat **hanya gap**: requirement di `HANDOVER.md` yang **belum ada (MISSING)** atau **berbeda dari spesifikasi (DIFFERENT)**.

Jika implementasi **melebihi** blueprint, tidak dicatat di sini. Yang sudah sesuai juga tidak dicatat, kecuali untuk melaporkan bahwa seksi tersebut bersih.

| Metadata | Nilai |
| --- | --- |
| Tanggal | 2026-09-18 |
| Commit | `070fc511` |
| Branch | `master` (sinkron dengan `origin/master`) |
| Upstream | `minbrowser/min` @ `c92079cd` (Min 1.35.7) |
| Metode | Pembacaan kode + verifikasi `file:line` |
| Cakupan | §1–§36 |

Catatan metode: `dist/bundle.js`, `dist/bundle.css`, dan `main.build.js` adalah hasil build, jadi tidak pernah dipakai sebagai bukti. Semua rujukan menunjuk file sumber.

Dokumen ini menggantikan `docs/HANDOVER_AUDIT.md` yang ditulis sebelum refactor `Workspace → Task → Tab` dan sudah usang di beberapa bagian (lihat **Catatan** di akhir).

---

## Ringkasan

| § | Topik | Gap |
| --- | --- | --- |
| 2 | Core hierarchy | DIFFERENT — model Task kurang 2 anggota |
| 3 | Favicon | — bersih |
| 4 | Workspace model | MISSING — `createdAt`/`updatedAt`; DIFFERENT — `sidebarState`, prefill nama |
| 5 | Workspace switching | DIFFERENT — tile state tidak kembali |
| 6 | Workspace persistence | MISSING — tile relationship, tile width, notes; DIFFERENT — AI reference |
| 7 | Archive Workspace | MISSING — auto-unpin |
| 8 | Missing workspace path | DIFFERENT — deteksi path hilang tidak ada |
| 9 | Profiles | MISSING — Clear Data; DIFFERENT — delete tidak diblokir |
| 10 | Profile switching | DIFFERENT — semua view dibongkar, bukan hanya web tab |
| 11 | Clear Profile Data | MISSING — seluruh fitur |
| 12 | Central database | MISSING — sebagian besar tabel; DIFFERENT — JSON, bukan DB |
| 13 | Tabs | MISSING — tab `kind` + metadata; DIFFERENT — path bocor di URL |
| 14 | Monaco editor | MISSING — autosave |
| 15 | Terminal | DIFFERENT — cwd/scrollback tidak dipersist |
| 16 | Documents | MISSING — source mode, Mermaid; DIFFERENT — bentuk tool AI |
| 17 | Notes | MISSING — seluruh fitur |
| 18 | Sidebar | MISSING — aktivitas Notes |
| 19 | File Tree | — bersih |
| 20 | Git | DIFFERENT — diff working tree tidak terjangkau dari UI |
| 21 | Tile / Split View | DIFFERENT — maks 2 panel, tidak persisten |
| 22 | Pinned Tasks | MISSING — seluruh fitur |
| 23 | Download preference | MISSING — tidak Task-scoped |
| 24 | AI coding agent | DIFFERENT — hanya OpenRouter |
| 25 | AI session model | DIFFERENT — history per Task, bukan per Workspace; MISSING — ownership |
| 26 | Browser control | MISSING — baca teks halaman; DIFFERENT — internal tab tidak dikecualikan |
| 27 | Extra settings page | MISSING — 4 seksi |
| 28 | Startup behavior | DIFFERENT — tile set tidak direstore |
| 29 | Task deletion | MISSING — pinned task, download preference |
| 30 | Workspace deletion | MISSING — pinned task; DIFFERENT — AI history |
| 31 | Architecture guidelines | DIFFERENT — duplikasi store, global swap, tanpa `ide/` |
| 32 | Upstream compatibility | DIFFERENT — footprint core besar (remote sudah benar) |
| 33 | Implementation order | Sebagian fase belum lengkap |
| 34 | Non-goals | — dipatuhi |
| 35 | Coding-agent working rules | VIOLATION — 3 aturan |
| 36 | Definition of success | 6 dari 15 langkah belum penuh |

Tiga hal yang paling sering muncul sebagai akar gap: **tile/split view tidak dipersist**, **tab metadata tidak ada**, dan **AI session ownership tidak dimodelkan**.

---

## §2 Core hierarchy

- **DIFFERENT** — Dua anggota model di level Task tidak ada di objek Task: **tiled tab relationships** dan **task-scoped preferences**. Field Task hanya `name/tabs/tabHistory/collapsed/id/selectedInWindow` (`js/tabState/task.js:41-49`). Tiling hidup sebagai satu array `splitView.groups` yang global per window dan session-only (`js/splitView.js:23-24`), dan tidak ada store task-scoped preferences sama sekali.

Hierarki `Workspace → Task → Tab` itu sendiri **sudah nyata** (bukan lagi alias) dan tidak dicatat sebagai gap.

---

## §4 Workspace

- **MISSING** — Field `createdAt` dan `updatedAt` tidak ada di record workspace. `makeWorkspace` hanya membuat `id, name, profileId, path, archived, activeTaskId, collapsed, selectedInWindow, tasks` (`js/tabState/workspace.js:10-22`).
- **DIFFERENT** — `sidebarState` dan `activityBarVisible` bukan field workspace seperti di blueprint, melainkan disimpan terpisah di IndexedDB dengan key `workspace:<id>` (`js/util/uiStateDB.js:13-16,44-60`; ditulis dari `js/sidebar.js:204-221`). Fungsional tetap persisten per workspace, tapi bukan bagian dari data model workspace.
- **DIFFERENT** — Modal create tidak mengisi nama default; input dikosongkan (`js/workspaceDrawer/workspaceDrawer.js:67`). Blueprint minta nama default sudah terisi dan langsung editable saat modal dibuka. (Pola namanya sendiri sudah benar: `defaultWorkspaceName` = `Workspace %n`.)

Kepemilikan nama default sudah dipisah dengan benar: task memakai `defaultTaskName`, workspace memakai `defaultWorkspaceName` (`js/workspaceDrawer/workspaceDrawer.js:161,220,466`).

---

## §5 Workspace switching

- **DIFFERENT** — "tiled state kembali" tidak terjadi. `switchToWorkspace` memanggil `splitView.clearAll()` (`js/browserUI.js:550`) dan task switch juga membersihkannya (`js/splitView.js:434-437`). Split group dinyatakan eksplisit sebagai session-only dan window-local (`js/splitView.js:3`).

Task terakhir, tab terakhir, sidebar state, dan runtime yang tetap hidup sudah sesuai.

---

## §6 Workspace persistence

- **MISSING** — **Tiled relationships** tidak dipersist. Tidak ada collection tile di `js/util/uiStateDB.js:13-38`, dan blob session v3 hanya membawa workspaces → tasks → tabs (`js/sessionRestore.js:19-34`).
- **MISSING** — **Tile width** tidak dipersist; `splitRatio` selalu di-reset ke `0.5` setiap kali pasangan dibuka (`js/splitView.js:115,125`).
- **MISSING** — **Notes** tidak dipersist karena subsistemnya tidak ada sama sekali (lihat §17).
- **DIFFERENT** — "AI-related references": pointer ke session aktif milik sebuah task adalah Map in-memory (`main/agent.js:22`) yang tidak pernah ditulis ke disk, sehingga setelah restart session mana yang terpasang tidak kembali dan dipilih ulang secara heuristik (`main/agent.js:329-333`).

---

## §7 Archive Workspace

- **MISSING** — **Auto-unpin semua pinned Task** milik workspace yang di-archive tidak bisa terjadi karena tidak ada konsep pin sama sekali di codebase. Langkah archive lainnya sudah berjalan: halaman di-unload, terminal dihentikan, dan live agent session dibuang (`js/browserUI.js:416-464`).

---

## §8 Missing workspace path

- **DIFFERENT** — Tidak ada **deteksi** path yang sudah tidak ada/tidak accessible, dan tidak ada **indikator** `folder + slash/warning`. Row workspace hanya merender path bila truthy, dengan class polos (`js/workspaceDrawer/workspaceDrawer.js:164-170`; `css/workspaceDrawer.css:79-87`).
- **DIFFERENT** — Files dan Git disembunyikan hanya ketika `ws.path` **kosong**, bukan ketika path tersimpan sudah hilang: `hasPath = !!(ws && ws.path)` (`js/sidebar.js:69-96`). Dengan path yang sudah tidak ada, tab tetap tampil dan tree hanya menampilkan baris error (`js/sidebar/fileTree.js:196-198,233-237`) alih-alih memperlakukan workspace sebagai browser-only.

Dua hal yang sudah sesuai: stored path tidak dihapus otomatis, dan path bisa diganti lewat Workspace Settings.

---

## §9 Profiles

- **MISSING** — Profile manager tidak punya **Clear Data**. Tab Profiles hanya menyediakan create/rename/delete (`pages/proSettings/proSettings.js:211-349`; markup `pages/proSettings/index.html:71-83`).
- **DIFFERENT** — Aturan "profile tidak boleh dihapus selama masih digunakan Workspace" tidak ditegakkan. Penghapusan diizinkan; workspace terdampak diam-diam dipindah ke default. `confirmProfileDeletion` hanya memeriksa editor yang belum disimpan (`js/browserUI.js:361-368`), lalu `applyProfileDeleted` menulis `profileId: null` (`js/browserUI.js:370-402`), dan halaman settings ikut menulis ulang `profileId` tersimpan (`pages/proSettings/proSettings.js:305-331`).

---

## §10 Profile switching

- **DIFFERENT** — Mengganti profile sebuah workspace membongkar **semua** view, bukan hanya web tab. `setWorkspaceProfile` mengiterasi seluruh tab di seluruh task dan memanggil `webviews.destroy(tab.id)` (`js/browserUI.js:326-331`), sehingga tab editor (Monaco) dan terminal ikut mati — bertentangan dengan "editor tidak berubah, terminal tidak berubah". PTY terminal mati karena di-key ke `webContents` yang dihancurkan (`main/terminal.js:82-84`).

---

## §11 Clear Profile Data

- **MISSING** — Tidak ada UI clear-data per profile sama sekali, baik di Pro Settings maupun di tempat lain. Yang ada hanya bang global `!clearhistory`, yang sekaligus menghapus DB history dan membersihkan **semua** partisi profile tanpa pilihan per-profile maupun per-jenis data (`js/searchbar/customBangs.js:153-165`; `main/remoteActions.js:48-85`).
- **MISSING** — Tidak ada cascade "berlaku untuk semua live workspace yang memakai profile itu", dan tidak ada reload/logout web tab terdampak.

---

## §12 Central database

- **DIFFERENT** — Yang ada bukan database melainkan **satu file JSON**. `main/dbService.js` menyimpan seluruh state di objek in-memory dan menuliskannya atomik sebagai `custom_app_data.db` (`main/dbService.js:22-31,150-158`). `CENTRALIZED_SQLITE_PLAN.md` belum dijalankan.
- **MISSING** — `workspaces`, `workspace_state`, `task_extra_state`, dan `tab_extra_metadata` tidak ada di DB. State workspace/task/tab ditulis ke `sessionRestore.json` + `localStorage['taskRestoreData']` (`js/sessionRestore.js:19-61`). Permukaan IPC DB hanya mencakup preferences/profiles/snapshots/designs/documents/activities (`main/dbService.js:618-670`).
- **DIFFERENT** — `profiles` disimpan utama di `localStorage['workspaceProfiles']`; DB hanya mirror sekunder (`js/profiles.js:11-44`; `pages/proSettings/proSettings.js:147-164`).
- **DIFFERENT** — `sidebar_state` tidak di DB melainkan di IndexedDB Dexie (`js/util/uiStateDB.js:13-29,44-60`).
- **MISSING** — `notes` dan `tile_state` tidak punya storage sama sekali.
- **DIFFERENT** — AI config/provider tidak di DB melainkan di `settings.json` dan Map in-memory (`main/agent.js:22,402-404`; `js/util/settings/settings.js:16-44`).
- **DIFFERENT** — Empat collection di `dbService` adalah **dead code** (nol pemanggil di luar layer DB): `user_preferences`, `workspace_snapshots`, `design_documents`, `tab_activities` (`main/dbService.js:23-31`; wrapper IPC-nya masih ada di `js/util/customDataStore.js:52-79`).

Yang sudah sesuai: website storage tetap di Electron session partition, tidak dipindah ke DB custom.

---

## §13 Tabs

- **DIFFERENT** — Internal URL **membocorkan resource sebenarnya**, persis kasus yang dilarang blueprint. Editor: `min://app/pages/editor/index.html?path=<path absolut>&workspace=<path absolut>` (`js/editorView.js:11-18`). Terminal: `min://terminal?cwd=<path absolut>` (`js/searchbar/customBangs.js:116-119`). Path ini dikembalikan ke address bar oleh `urlParser.getSourceURL` (`js/util/urlParser.js:108-127`). Docs sudah benar karena memakai id opaque.
- **MISSING** — Metadata tab `{tabId, kind, filePath}` tidak disimpan di luar URL. Record tab tidak punya field `kind`/`filePath` (`js/tabState/tab.js:14-33`); `filePath` diturunkan ulang dari URL saat dibutuhkan (`js/editorView.js:59-69`). Tidak ada union `TabKind`.

---

## §14 Monaco editor

- **MISSING** — **Autosave** dengan delay pendek. Editor hanya menyimpan saat Ctrl/Cmd+S atau lewat akselerator menu aplikasi (`pages/editor/editor.js:113-138,262`); perubahan isi hanya menyalakan flag dirty (`pages/editor/editor.js:246-248`). Tidak ada timer/debounce di mana pun.

Preview/temporary tab, focus existing tanpa duplikat, pin saat edit/double-click, dan scope per task sudah sesuai blueprint.

---

## §15 Terminal

- **DIFFERENT** — Persistence `cwd` untuk kasus archive/restart tidak benar-benar melacak shell. cwd hanya diturunkan dari `workspace.path` saat tab dibuka (`js/searchbar/customBangs.js:116-119`) dan dibaca kembali dari query URL saat spawn (`pages/terminal/terminal.js:8-14,71-74`). Jika user `cd` di dalam shell, cwd terakhir itu tidak tersimpan, dan tidak ada scrollback/history/shell metadata yang dipersist sama sekali.

PTY nyata, session per tab, default cwd, dan berhenti saat tab/task/workspace dihapus atau di-archive sudah sesuai.

---

## §16 Documents

- **MISSING** — **Tombol switch ke Source.** Editor dibuat dengan `hideModeSwitch: true` dan tidak ada penggantinya; header halaman hanya berisi title, checkbox private, dan status save (`pages/docs/docs.js:137-157`; `pages/docs/index.html:14-24`).
- **MISSING** — **Render Mermaid.** Tidak ada dependency mermaid maupun integrasi renderer kustom; bundle editor adalah Toast UI polos (`pages/docs/editorBundle.js:1`; `pages/docs/docs.js:137-157`).
- **DIFFERENT** — Tool AI tidak diekspos sebagai `listDocuments` / `readDocument` / `editDocument`, melainkan satu tool `docs` dengan operasi `list|search|get|create|update` (`main/agentTools.js:277-338`). Secara fungsi setara, jadi ini gap bentuk antarmuka saja.

---

## §17 Notes

- **MISSING** — Seluruh fitur. Tidak ada page, panel, store, maupun reuse editor: daftar panel sidebar hanya `ai/files/git/playbook/design/docs` (`index.html:289-294`), tidak ada collection notes di `dbService` (`main/dbService.js:23-31`), dan tidak ada file sumber notes.

Aturan "AI tidak boleh punya akses ke Notes" terpenuhi secara trivial justru karena Notes belum ada.

---

## §18 Sidebar

- **MISSING** — Aktivitas **Notes** tidak ada di activity bar. Blueprint mencantumkan aktivitas `AI Chat, Files, Git, Documents, Notes`; yang terpasang hanya `ai`, `files`, `git`, `playbook`, `design`, `docs` (`index.html:237-294`; registry panel di `js/sidebar.js:56`). Sebagai gantinya ada dua aktivitas di luar blueprint (`playbook`, `design`) — itu kelebihan, bukan gap.

Yang sudah sesuai: Files/Git disembunyikan saat tanpa path, Docs tetap tampil tanpa filesystem, panel mendorong konten lewat margin (bukan overlay), dan state persisten per workspace.

---

## §20 Git

- **DIFFERENT** — **Diff working tree tidak terjangkau dari UI.** Handler ada (`main/git.js:332` `ipc.handle('gitDiff', …)`) tetapi tidak ada renderer yang memanggilnya; satu-satunya pemakaian diff adalah diff per-commit lewat `gitCommitDiff` (`js/sidebar/gitPanel.js:844`). Klik file yang berubah membuka file di editor, bukan menampilkan diff (`js/sidebar/gitPanel.js:453-458`).

Item §20 lainnya sudah ada, termasuk deteksi repo untuk workspace di subfolder (`main/git.js:58-77,199-216`), stage/unstage, commit, branch, checkout, pull/push/sync, conflict indicator, dan refresh.

---

## §21 Tile / Split View

- **DIFFERENT** — **Maksimal 2 panel, bukan 3.** Modulnya didokumentasikan dan ditulis sebagai "groups of two tabs"; pasangan hanya dibuat lewat `enterWithPair(tabAId, tabBId)` (`js/splitView.js:2-5,23-24,92-128`). Tidak ada jalur untuk menile tab ketiga, sehingga skenario `A+B+C → A+C` tidak bisa dimodelkan.
- **DIFFERENT** — **Tiled relationship tidak dipersist.** Header modul menyatakan state split "session-only and window-local … not persisted" (`js/splitView.js:3`); group hidup di array in-memory (`js/splitView.js:24,409`) dan dibersihkan saat task/workspace switch (`js/splitView.js:434-437`; `js/browserUI.js:202,324,381,485,550`).
- **DIFFERENT** — **Width panel tidak dipersist**; `splitRatio` in-memory dan selalu kembali `0.5` (`js/splitView.js:115,125`).

Yang sudah sesuai: columns only, semua tipe tab bisa ditile, divider resizable, association antar tab (bukan pane entity), satu tab hanya di satu association, dan auto-hapus saat tinggal satu.

---

## §22 Pinned Tasks

- **MISSING** — Seluruh fitur. Tidak ada API/persistensi pin di workspace maupun task (tidak ada field `pinned` di `js/tabState/workspace.js` / `js/tabState/task.js`), tidak ada UI quick-nav lintas workspace, dan tidak ada auto-unpin saat archive. Satu-satunya pemakaian kata "pin" di codebase adalah konsep *preview tab* editor yang tidak berhubungan (`js/editorView.js:74`).

---

## §23 Download preference

- **MISSING** — **Last download directory tidak Task-scoped.** `downloadHandler` bergantung pada default save path per-session Electron dan hanya menetapkan direktori untuk alur capture Playbook/browser-control (`main/download.js:54-107`; `main/download.js:3,60-66`; `main/browserControl.js:1295`). Tidak ada direktori per-task maupun asosiasi task di jalur download, dan `js/tabState/tab.js` tidak menyimpan preferensi download.

---

## §24 AI coding agent

- **DIFFERENT** — **"Support multiple providers" tidak terwujud.** Hanya OpenRouter yang bisa dikonfigurasi dan diautentikasi: `PROVIDER_LABELS` hanya berisi `openrouter` (`main/agent.js:30-32`), API key dibaca dari `openrouterApiKey` dan runtime key hanya di-set untuk openrouter (`main/agent.js:402-404,426`), uji key di-hardcode ke endpoint OpenRouter (`main/agent.js:689`), dan halaman settings hanya menyediakan satu input key (`pages/proSettings/index.html:46-53`).

Model picker memang provider-aware lewat katalog SDK, tetapi tidak ada jalur kredensial untuk provider lain.

---

## §25 AI session model

- **DIFFERENT** — **History di-scope per Task, bukan per Workspace.** Blueprint minta `Workspace └── AI Sessions[]` sehingga semua task melihat history yang sama; kenyataannya session key adalah `'task-' + taskId` (`main/agent.js:91-99`), setiap task punya direktori session ter-hash sendiri (`main/agent.js:231-237`), listing hanya membaca direktori task itu (`main/agent.js:744-777`), dan renderer me-key conversation per task id (`js/sidebar/agentPanel.js:10-13,47-80`).
- **MISSING** — Model **"0 atau 1 active session per Task"** dengan status `active in Task A` / `available` tidak ada. Drawer history hanya menampilkan session task yang sedang dipilih tanpa label status (`js/sidebar/agentPanel.js:390-433`), dan `agent-open-session` menerima file `.jsonl` mana pun di bawah shared sessions root sehingga satu session bisa dibuka task lain (`main/agent.js:239-249,779-794`).
- **MISSING** — Perilaku **"Task A melepas Session 1 supaya Task lain bisa memakainya"** tidak ada; session hanya hidup di bawah key/direktori task pemiliknya dan tidak bisa di-detach lalu di-reattach.

---

## §26 Browser control for AI

- **MISSING** — Kemampuan **membaca teks/konten halaman**. Tidak ada action yang mengembalikan teks halaman: `snapshot` hanya mengeluarkan heading dan elemen interaktif (`main/browserControl.js:573-624`), dan `BROWSER_ACTIONS` tidak punya action baca teks (`main/agentTools.js:44-48`).
- **DIFFERENT** — Browser control **tidak dibatasi hanya ke web page**. Hanya URL settings/profile yang diblokir (`main/browserControl.js:97-113`; `js/browserControlRenderer.js:8-20`), sementara daftar tab mengembalikan seluruh tab di task tersebut (`js/browserControlRenderer.js:77-88`) dan resolusi tab menerima tab id apa pun di task itu (`js/browserControlRenderer.js:90-122`). Akibatnya tab editor, terminal, dan document (`min://`) bisa di-list dan dijadikan target, padahal blueprint menyatakan browser-control hanya untuk web page.

Kemampuan lain sudah ada: tab list/create/close/select, navigate/back/forward/reload, snapshot/inspect, click/type/select/scroll, upload/download, form, press/drag/hover.

---

## §27 Extra settings page

- **MISSING** — Seksi **Editor**.
- **MISSING** — Seksi **Terminal**.
- **MISSING** — Seksi **Workspace Defaults**.
- **MISSING** — Seksi **Documents**.

Halaman settings internal hanya punya tab Provider (OpenRouter), Profiles, dan Design (`pages/proSettings/index.html:17-21`; `pages/proSettings/proSettings.js:14-18`). Halaman ini bernama `min://proSettings` alih-alih `min://settings`, tapi blueprint membolehkan variasi itu.

---

## §28 Startup behavior

- **DIFFERENT** — Langkah "restore active tab/**tiled set**" tidak terpenuhi untuk bagian tile: state split tidak dipersist dan tidak direstore (`js/splitView.js:3`; `js/sessionRestore.js:19-64` tidak memuat state split).

Sisanya sudah sesuai, termasuk lazy restore dan archived workspace yang tetap cold.

---

## §29 Task deletion

- **MISSING** — **"remove pinned Task if pinned"** — tidak ada fitur maupun state pinned untuk dihapus (lihat §22).
- **MISSING** — **"remove task-scoped download preference"** — preferensi itu belum ada (lihat §23).

Item lain sudah berjalan: `closeTask` menghentikan agent session dan menghancurkan seluruh tab beserta view-nya (`js/browserUI.js:151-181`), dan PTY terminal mati saat `webContents`-nya dihancurkan (`main/terminal.js:81-84`).

---

## §30 Workspace deletion

- **MISSING** — **"remove pinned Tasks"** — tidak ada fitur pinned (lihat §22).
- **DIFFERENT** — **"remove workspace AI history/state as appropriate"** tidak dilakukan. Penghapusan hanya menghentikan session hidup lalu menghapus row document/design/snapshot/activity di DB; file history AI di disk tidak pernah dihapus. `js/browserUI.js:230-244` memanggil `agent-destroy-workspace-sessions`, yang handler-nya hanya memanggil `destroySession` (`main/agent.js:808-815`). Karena session sekarang per-task directory, file-nya menjadi orphan.

Document/design/snapshot/activity sudah tersapu benar lewat `db:deleteWorkspaceData` (`main/dbService.js:650-667`), dan Profile memang tidak dihapus sesuai blueprint.

---

## §31 Architecture guidelines

- **DIFFERENT** — **`WorkspaceStore` menduplikasi permukaan collection/event milik `TaskList`**, bukan sekadar integration hook tipis. `js/tabState/workspace.js:32-238` mengimplementasikan ulang `on/emit/add/update/get/getSelected/destroy/getStringifyableState/getCopyableState` yang sudah ada di `js/tabState/task.js:10-213`. Blueprint meminta pola `Min core → small integration hooks → IDE modules`.
- **DIFFERENT** — **Global swap `window.tasks`.** `repointTaskGlobal` mengganti `window.tasks` ke TaskList milik workspace terpilih pada setiap switch (`js/tabState/workspace.js:298-302`), `js/tabState.js:12-17` menyemai `new TaskList()` sekali pakai, dan `js/util/followTaskList.js:1-9` ada semata-mata untuk me-resubscribe setelah switch. Ini workaround arsitektur paralel, bukan reuse engine task Min di tempatnya. Modul terakhir itu bahkan hanya hidup untuk menambal efek samping dari swap tersebut.
- **DIFFERENT** — **Tidak ada pengelompokan `ide/`.** Modul fork tersebar dan bercampur dengan file core di `js/`, `js/sidebar/`, `js/tabState/`, `main/`, `pages/` (mis. `js/sidebar.js`, `js/profiles.js`, `js/splitView.js`, `js/editorView.js`, `js/docsView.js`, `js/browserControlRenderer.js`, `main/git.js`, `main/terminal.js`, `main/fileTree.js`, `main/dbService.js`, `main/agent.js`). Blueprint membolehkan penyesuaian struktur, jadi ini catatan, bukan pelanggaran.
- **DIFFERENT** — **Sniffing tipe tab diduplikasi** alih-alih memakai konsep `kind`: `isEditorURL`/`isEditorTab` (`js/editorView.js:20-26`), `isDocsURL` (`js/docsView.js:15-18`), dan deteksi terminal yang di-hardcode di `js/navbar/tabBar.js:18-35`. Tiga tempat memelihara logika metadata yang sama.

---

## §32 Upstream Min compatibility

- **DIFFERENT** — **Footprint perubahan core jauh dari "kecil dan terkelompok".** Diukur terhadap merge base `c92079cd`, fork **mengedit 37 file milik upstream** dengan total **+2478 / -533 baris**, dan menambah 261 file baru. File core yang berubah paling berat:

  | File | Perubahan |
  | --- | --- |
  | `js/browserUI.js` | +467 / −29 |
  | `localization/languages/en-US.json` | +231 / −3 |
  | `js/navbar/tabBar.js` | +223 / −29 |
  | `main/viewManager.js` | +203 / −37 |
  | `index.html` | +188 / −40 |
  | `js/webviews.js` | +122 / −82 |
  | `js/sessionRestore.js` | +117 / −52 |

  Blueprint meminta "kurangi perubahan core yang tidak perlu; hindari rewrite besar kalau extension cukup".

Yang sudah benar dan terverifikasi: `origin` = `github.com/mbash12/min-ide`, `upstream` = `github.com/minbrowser/min`, `remote.pushDefault = origin`, dan `master` lokal identik dengan `origin/master`.

---

## §33 Implementation order

**Phase 1 — Foundation**
- central DB — **belum**: masih satu file JSON dan workspaces/tabs tidak ada di dalamnya (`main/dbService.js:8,23-31,150-158`; `js/sessionRestore.js:19`).
- Sisanya selesai: fork build/run, favicon, Workspace model, Profile model, Workspace drawer, workspace persistence, dan hierarki `Workspace → Task → Tab`.

**Phase 2 — Workspace runtime**
- pinned Tasks — **belum ada** (`js/tabState/task.js`, `js/tabState/workspace.js` tidak punya field pin; tidak ada UI).
- Sisanya selesai: switching, restart restoration, archive, lazy restore, profile session isolation, dan workspace settings modal.

**Phase 3 — IDE surfaces** — seluruh item selesai (Activity Bar, Sidebar, File Tree, Monaco, Terminal, dan editor/terminal hidup sebagai tab Min biasa).

**Phase 4 — Development UX**
- autosave — **belum**: hanya ada di editor Docs (`pages/docs/docs.js:54-114`), Monaco manual (`pages/editor/editor.js:113,262`).
- tile/split view — **sebagian**: ada tapi maks 2 panel dan tidak persisten.
- temporary editor tabs dan Git sidebar selesai.

**Phase 5 — Documents**
- Notes — **belum ada**.
- source mode — **belum ada**.
- Mermaid — **belum ada**.
- Documents dan WYSIWYG Markdown selesai.

**Phase 6 — AI**
- providers (jamak) — **belum**: hanya OpenRouter (`main/agent.js:30-32,426,689`).
- workspace history — **belum**: history per Task (`main/agent.js:91-99,231-237`).
- AI sessions, task/session ownership, filesystem/shell agent, dan document tools selesai.

**Phase 7 — Browser control** — action lengkap dan isolasi per task ditegakkan, tetapi pembatasan "web tabs only" belum (lihat §26).

---

## §34 Important non-goals

Tidak ada non-goal yang dilanggar. Verifikasi: tidak ada multi-window milik fork (`selectedInWindow` adalah upstream), tidak ada grid/nested tiling (maks 2 panel), workspace single-root (satu field `path`), tidak ada Notes sehingga tidak ada akses AI ke Notes, dan tidak ada cloud sync / account / marketplace / remote dev / mobile. `main/keychainService.js` adalah password manager bawaan Min (upstream), dan `main/permissionManager.js:58-80` adalah permission website (media/notifikasi/pointer lock), bukan permission enterprise.

---

## §35 Coding-agent working rules

- **VIOLATION (rule 4 — "jangan rewrite tab engine")** — Engine tab membawa banyak logika fork: split-pane attach/detach dan routing workspace dijalin ke `js/webviews.js:85,144-148,269-297,331-438` dan `main/viewManager.js:338-415,445-506`, serta bootstrap tab-state diganti di `js/tabState.js:1-17`.
- **VIOLATION (rule 2 & 7 — "reuse native behavior / jangan buat abstraction sebelum perlu")** — Kombinasi global swap `window.tasks` (`js/tabState/workspace.js:298-302`) plus modul kompensasi `js/util/followTaskList.js:1-9`, ditambah alias `window.WorkspaceList`/`window.TaskList` di `js/tabState.js:12-17`.
- **VIOLATION (rule 3 — "jangan rewrite Task")** — Ringan. `js/tabState/task.js` dekat dengan upstream, tetapi menambah `reorder()` non-upstream yang memancarkan `task-moved` (`js/tabState/task.js:178-185`) dan mengubah `isCollapsed` agar memakai `this` (`:171-176`).

---

## §36 Definition of success

| Langkah | Status | Bukti |
| --- | --- | --- |
| Launch → Workspace 1 + Task "Development" aktif | Sebagian | Fresh start membuat `Workspace 1` tanpa task bernama "Development" dan tanpa path default; membuka tab tour Min (`js/sessionRestore.js:103-107,116-121`) |
| Files sidebar menunjukkan project | Sebagian | Files/Git/Design disembunyikan sampai `workspace.path` diisi manual, jadi workspace baru tampil kosong (`js/sidebar.js:61-82`; `js/sidebar/fileTree.js:33-34`) |
| Click source file → Monaco terbuka | OK | `js/sidebar/fileTree.js:161-167` |
| Open Terminal → shell di project root | Sebagian | cwd benar, tapi hanya bisa dibuat lewat bang `!term`; tidak ada item menu/navbar (`js/searchbar/customBangs.js:110-121`) |
| Tile `Monaco \| Website \| Terminal` (3 panel) | Tidak | Split view dibatasi 2 panel (`js/splitView.js:24,92-118`) |
| AI agent aktif di task tersebut | OK | `js/sidebar/agentPanel.js:54-69`; `main/agent.js:395-513` |
| Agent edit source & jalankan command | OK | `main/agent.js:448` |
| Agent kontrol web tab untuk testing | OK | `main/agentTools.js:77-168`; isolasi task di `js/browserControlRenderer.js:90-122` |
| Create Task lain → AI session paralel | Sebagian | Session memang per-task dan independen, tapi panel hanya men-stream task terpilih (`js/sidebar/agentPanel.js:32`), tidak ada owner/lock, dan doc modul menyatakan tidak menjalankan chat paralel (`main/agent.js:9-11`) |
| Switch Workspace → state sebelumnya hidup | OK | `js/tabState/workspace.js:5-8`; `js/browserUI.js:523-555` |
| Return → layout & runtime sama | Sebagian | Runtime hidup, tapi tile hilang setiap task/workspace switch (`js/browserUI.js:485,550`; `js/splitView.js:2-3`) |
| Archive Workspace → runtime dilepas | OK | `js/browserUI.js:448-462` |
| Reopen → state restored lazily | Sebagian | Task/tab restore lazily (`js/sessionRestore.js:137-149`), tile tidak kembali |
| Restart → Workspace/Task/layout kembali, load lazy | Sebagian | Restore workspace/task/tab dan lazy view creation jalan (`js/sessionRestore.js:137-165`), tile hilang |

Yang menghalangi "cukup untuk dipakai harian": **tile 3 panel + persistensinya**, dan **pintu masuk terminal di UI**.

---

## Catatan

Tiga hal yang sudah ditutup bersamaan dengan dokumen ini, jadi tidak lagi terhitung sebagai gap:

1. **Banner `HANDOVER.md:3-5`** sudah diperbarui: menyatakan hierarki `Workspace → Task → Tab` sudah nyata, dan menautkan dokumen ini sebagai acuan status.
2. **`docs/HANDOVER_AUDIT.md`** sudah ditandai `SUPERSEDED` dengan daftar bagian yang tidak lagi akurat (§1.1, §7, §10, §25, §32), dan baris tabel ringkasannya dikoreksi. Isinya tetap disimpan sebagai catatan kondisi kode sebelum refactor.
3. **Penamaan task di lokalisasi** sudah dirapikan: key task-level di `localization/languages/id.json` kembali berbunyi "Task" (`taskN`, `defaultTaskName`, `viewTasks`, `newTask`, `switchToTask`, `createTask`, `closeTask`, `moveToTask`, `nameTask`, `taskDeleteWarning`, `taskSettings`, `taskRename`, `taskDelete`, `returnToTask`, `appMenuNewTask`, `focusModeExplanation1`). Dua sisa di `en-US` juga ikut diperbaiki (`taskDeleteWarning` → "Task deleted", `returnToTask` → "Return to your previous task"). Nama default workspace dipisah ke key baru `defaultWorkspaceName` (`Workspace %n`) supaya tidak ikut berubah menjadi "Task".

Catatan kecil: key `taskN` tidak dipakai di mana pun di kode (tidak ada pemanggil `l('taskN')`), nilainya tetap diselaraskan agar tidak menyesatkan.
