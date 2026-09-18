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
| 2 | Core hierarchy | DIFFERENT — task-scoped preferences |
| 3 | Favicon | — bersih |
| 4 | Workspace model | DIFFERENT — `sidebarState` |
| 5 | Workspace switching | — bersih |
| 6 | Workspace persistence | MISSING — notes; DIFFERENT — AI reference |
| 7 | Archive Workspace | MISSING — auto-unpin |
| 8 | Missing workspace path | DIFFERENT — deteksi path hilang tidak ada |
| 9 | Profiles | MISSING — Clear Data; DIFFERENT — delete tidak diblokir |
| 10 | Profile switching | DIFFERENT — semua view dibongkar, bukan hanya web tab |
| 11 | Clear Profile Data | MISSING — seluruh fitur |
| 12 | Central database | MISSING — sebagian besar tabel; DIFFERENT — JSON, bukan DB |
| 13 | Tabs | — bersih |
| 14 | Monaco editor | — bersih |
| 15 | Terminal | DIFFERENT — cwd/scrollback tidak dipersist |
| 16 | Documents | MISSING — source mode, Mermaid; DIFFERENT — bentuk tool AI |
| 17 | Notes | MISSING — seluruh fitur |
| 18 | Sidebar | MISSING — aktivitas Notes |
| 19 | File Tree | — bersih |
| 20 | Git | — bersih |
| 21 | Tile / Split View | — bersih |
| 22 | Pinned Tasks | MISSING — seluruh fitur |
| 23 | Download preference | MISSING — tidak Task-scoped |
| 24 | AI coding agent | DIFFERENT — hanya OpenRouter |
| 25 | AI session model | DIFFERENT — history per Task, bukan per Workspace; MISSING — ownership |
| 26 | Browser control | — bersih |
| 27 | Extra settings page | MISSING — 4 seksi |
| 28 | Startup behavior | — bersih |
| 29 | Task deletion | MISSING — pinned task, download preference |
| 30 | Workspace deletion | MISSING — pinned task |
| 31 | Architecture guidelines | DIFFERENT — duplikasi store, global swap, tanpa `ide/` |
| 32 | Upstream compatibility | DIFFERENT — footprint core besar (remote sudah benar) |
| 33 | Implementation order | Sebagian fase belum lengkap |
| 34 | Non-goals | — dipatuhi |
| 35 | Coding-agent working rules | VIOLATION — 3 aturan |
| 36 | Definition of success | 3 dari 14 langkah belum penuh |

Dua hal yang paling sering muncul sebagai akar gap: **tab metadata tidak ada** (§13, §26, §31) dan **AI session ownership tidak dimodelkan** (§25, §29, §30).

---

## §2 Core hierarchy

- **DIFFERENT** — Satu anggota model di level Task masih belum ada: **task-scoped preferences**. Tidak ada store untuk preferensi per task. (Tiled relationships sudah terpenuhi: task membawa `splitState` — `js/tabState/task.js:49-52`, diisi oleh `js/splitView.js`.)

Hierarki `Workspace → Task → Tab` itu sendiri **sudah nyata** (bukan lagi alias) dan tidak dicatat sebagai gap.

---

## §4 Workspace

- **DIFFERENT** — `sidebarState` dan `activityBarVisible` bukan field workspace seperti di blueprint, melainkan disimpan terpisah di IndexedDB dengan key `workspace:<id>` (`js/util/uiStateDB.js:13-16,44-60`; ditulis dari `js/sidebar.js:204-221`). Fungsional tetap persisten per workspace, tapi bukan bagian dari data model workspace.
Kepemilikan nama default sudah dipisah dengan benar: task memakai `defaultTaskName`, workspace memakai `defaultWorkspaceName` (`js/workspaceDrawer/workspaceDrawer.js:161,220,466`).

---

## §5 Workspace switching

Task terakhir, tab terakhir, tiled state, sidebar state, dan runtime yang tetap hidup sudah sesuai.

---

## §6 Workspace persistence

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

Seluruh requirement sudah sesuai: URL internal generik (`min://app/pages/editor/index.html`, `min://terminal`) tanpa resource di dalamnya, resource disimpan di metadata tab (`kind` + `resource`, keduanya ikut persist), dan address bar menampilkan bentuk generik (`min://editor`, `min://terminal`) melalui `urlParser.getSourceURL`.

Resource sampai ke halamannya lewat preload, bukan lewat URL: `js/webviews.js` menyertakannya saat membuat view, `main/viewManager.js` menyimpannya per view, dan `js/preload/default.js` menyerahkannya ke halaman sebagai `window.minViewResource` (sinkron, sebelum skrip halaman jalan — perlu `contextBridge` karena view memakai context isolation). Batas akses file editor ikut pindah: `main/editorFileIO.js` membaca resource view, bukan query URL.

Sisa yang diketahui: tab editor/terminal yang dibuat **sebelum** perubahan ini masih menyimpan URL lamanya di session, sehingga path-nya masih tampil di address bar sampai tab itu dibuka ulang. Tab seperti itu tetap berfungsi karena resource-nya dibaca dari query sebagai fallback (`legacyResourceFromURL`).

---

## §14 Monaco editor

Seluruh requirement sudah sesuai, termasuk **autosave**: perubahan memicu debounce 700 ms yang menulis file lewat jalur simpan yang sama dengan Ctrl/Cmd+S (`pages/editor/editor.js`), ditambah flush saat halaman kehilangan fokus atau disembunyikan supaya ketikan terakhir tidak tertinggal di timer. Simpan manual tetap ada, dan guard dirty saat menutup tab tetap berlaku sebagai jaring pengaman.

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

Semua item sudah ada, termasuk **diff working tree**: klik baris file menampilkan diff-nya di bawah baris itu lewat `ipc.invoke('gitDiff', …)` (`js/sidebar/gitPanel.js`), dengan satu diff terbuka pada satu waktu. Renderer diff dipakai bersama dengan tampilan commit (`renderDiffRows`). Untuk file untracked panel menampilkan catatan agar di-stage dulu, karena git tidak punya pembanding sebelum itu; "Open File" tetap tersedia di menu klik-kanan baris.

Item §20 lainnya sudah ada, termasuk deteksi repo untuk workspace di subfolder (`main/git.js:58-77,199-216`), stage/unstage, commit, branch, checkout, pull/push/sync, conflict indicator, dan refresh.

---

## §21 Tile / Split View

Seluruh requirement sudah sesuai: maksimal 3 panel, columns only, semua tipe tab bisa ditile, divider resizable (satu divider per gutter, `js/splitViewDivider.js`), width dan tiled relationship dipersist per task (`fractions` + field `splitState`), association antar tab (bukan pane entity), satu tab hanya di satu association, `A+B+C → A+C` saat satu pane di-untile atau ditutup, dan relationship otomatis hilang begitu tinggal satu tab.

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

Seluruh requirement sudah sesuai. Pembatasan "web tabs only" ditegakkan lewat `kind` (`js/browserControlRenderer.js` `isWebTab`); URL settings/profile tetap dicek karena tab itu tetap `kind: 'web'`. Membaca teks halaman tersedia lewat `action=read` (`main/browserControl.js` op `read`), yang mengembalikan `innerText` yang sudah dirapikan dengan batas karakter dan penanda truncation — melengkapi `snapshot` yang hanya mengeluarkan heading dan elemen interaktif.

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

Seluruh langkah sudah sesuai, termasuk restore active tab dan tiled set (layout split disimpan per task dan dipasang kembali saat task dipilih — `js/browserUI.js:520-521`), lazy restore, dan archived workspace yang tetap cold.

---

## §29 Task deletion

- **MISSING** — **"remove pinned Task if pinned"** — tidak ada fitur maupun state pinned untuk dihapus (lihat §22).
- **MISSING** — **"remove task-scoped download preference"** — preferensi itu belum ada (lihat §23).

Item lain sudah berjalan: `closeTask` menghentikan agent session dan menghancurkan seluruh tab beserta view-nya (`js/browserUI.js:151-181`), dan PTY terminal mati saat `webContents`-nya dihancurkan (`main/terminal.js:81-84`).

---

## §30 Workspace deletion

- **MISSING** — **"remove pinned Tasks"** — tidak ada fitur pinned (lihat §22).

Document/design/snapshot/activity sudah tersapu benar lewat `db:deleteWorkspaceData` (`main/dbService.js:650-667`), berkas transkrip AI tiap task ikut dihapus (`main/agent.js` `deleteTaskSessionFiles`), dan Profile memang tidak dihapus sesuai blueprint.

---

## §31 Architecture guidelines

- **DIFFERENT** — **`WorkspaceStore` menduplikasi permukaan collection/event milik `TaskList`**, bukan sekadar integration hook tipis. `js/tabState/workspace.js:32-238` mengimplementasikan ulang `on/emit/add/update/get/getSelected/destroy/getStringifyableState/getCopyableState` yang sudah ada di `js/tabState/task.js:10-213`. Blueprint meminta pola `Min core → small integration hooks → IDE modules`.
- **DIFFERENT** — **Global swap `window.tasks`.** `repointTaskGlobal` mengganti `window.tasks` ke TaskList milik workspace terpilih pada setiap switch (`js/tabState/workspace.js:298-302`), `js/tabState.js:12-17` menyemai `new TaskList()` sekali pakai, dan `js/util/followTaskList.js:1-9` ada semata-mata untuk me-resubscribe setelah switch. Ini workaround arsitektur paralel, bukan reuse engine task Min di tempatnya. Modul terakhir itu bahkan hanya hidup untuk menambal efek samping dari swap tersebut.
- **DIFFERENT** — **Tidak ada pengelompokan `ide/`.** Modul fork tersebar dan bercampur dengan file core di `js/`, `js/sidebar/`, `js/tabState/`, `main/`, `pages/` (mis. `js/sidebar.js`, `js/profiles.js`, `js/splitView.js`, `js/editorView.js`, `js/docsView.js`, `js/browserControlRenderer.js`, `main/git.js`, `main/terminal.js`, `main/fileTree.js`, `main/dbService.js`, `main/agent.js`). Blueprint membolehkan penyesuaian struktur, jadi ini catatan, bukan pelanggaran.

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
| Open Terminal → shell di project root | OK | `js/terminalView.js`; pintu masuk: menu File > Open Terminal (`main/menu.js`) dan keybinding `addTerminal` (`js/defaultKeybindings.js`) |
| Tile `Monaco \| Website \| Terminal` (3 panel) | OK | Sampai 3 pane per group (`js/splitView.js` `maxPanesPerGroup`) |
| AI agent aktif di task tersebut | OK | `js/sidebar/agentPanel.js:54-69`; `main/agent.js:395-513` |
| Agent edit source & jalankan command | OK | `main/agent.js:448` |
| Agent kontrol web tab untuk testing | OK | `main/agentTools.js:77-168`; isolasi task di `js/browserControlRenderer.js:90-122` |
| Create Task lain → AI session paralel | Sebagian | Session memang per-task dan independen, tapi panel hanya men-stream task terpilih (`js/sidebar/agentPanel.js:32`), tidak ada owner/lock, dan doc modul menyatakan tidak menjalankan chat paralel (`main/agent.js:9-11`) |
| Switch Workspace → state sebelumnya hidup | OK | `js/tabState/workspace.js:5-8`; `js/browserUI.js:523-555` |
| Return → layout & runtime sama | OK | Runtime hidup dan layout split kembali dari `splitState` task (`js/browserUI.js:520-521`) |
| Archive Workspace → runtime dilepas | OK | `js/browserUI.js:448-462` |
| Reopen → state restored lazily | OK | Task/tab restore lazily (`js/sessionRestore.js:137-149`), layout split ikut kembali |
| Restart → Workspace/Task/layout kembali, load lazy | OK | Restore workspace/task/tab, lazy view creation, dan layout split (`js/sessionRestore.js:137-165`) |

Sisa langkah yang belum penuh adalah default saat pertama kali jalan (§36 baris 1–2) dan kepemilikan AI session (§36 baris 9).

---

## Sudah ditutup

Gap yang sudah dikerjakan setelah dokumen ini ditulis, dan tidak lagi dihitung di atas:

1. **§36 — pintu masuk terminal.** Terminal tab sebelumnya hanya bisa dibuat lewat bang `!term`. Sekarang ada `js/terminalView.js` (modul tunggal yang membuka terminal), item menu File > Open Terminal, dan keybinding default `addTerminal` (`ctrl+\``).
2. **Tile / split view sekarang persisten** (§5, §6, §21, §28). Layout disimpan per task sebagai field `splitState` (`js/tabState/task.js:49-52`), ditulis oleh `splitView.persist()` pada setiap perubahan group/ratio (`js/splitView.js`) dan dipasang kembali oleh `splitView.restoreForSelectedTask()` saat task dipilih (`js/browserUI.js:520-521`). Karena state-nya menempel di record task, ia ikut format session v3 yang sudah ada tanpa perubahan format. `clearAll()` sengaja tidak menulis apa pun: ia hanya membongkar tampilan, sehingga layout task tetap utuh saat kembali.
3. **Tile sampai 3 panel** (§21, §36). Group memegang 2–3 pane (`maxPanesPerGroup`), lebar tiap pane disimpan sebagai `fractions` yang selalu berjumlah 1, dan setiap gutter punya divider sendiri (`js/splitViewDivider.js`). Satu pane bisa dikeluarkan tanpa membubarkan group lewat "Remove from Split View" (`js/navbar/tabContextMenu.js`), dan menutup satu pane dari `A+B+C` menyisakan `A+C` tiled; group baru hilang saat tinggal satu pane.
4. **Metadata tab + URL internal generik** (§13, §26, §31). Tab membawa `kind` dan `resource`; URL editor dan terminal menjadi generik sehingga tidak ada path workspace di address bar maupun di session, dan resource sampai ke halaman lewat preload bridge. Browser control juga dibatasi ke tab `kind: 'web'` saja.
5. **Batch kecil**: autosave Monaco (§14), diff working tree di panel Git (§20), dan `createdAt`/`updatedAt` pada workspace (§4).
6. **Batch cepat lanjutan**: `action=read` untuk membaca teks halaman (§26), penghapusan berkas transkrip AI saat workspace dihapus (§30), dan prefill nama default di modal workspace (§4).

## Catatan

Tiga hal yang sudah ditutup bersamaan dengan dokumen ini, jadi tidak lagi terhitung sebagai gap:

1. **Banner `HANDOVER.md:3-5`** sudah diperbarui: menyatakan hierarki `Workspace → Task → Tab` sudah nyata, dan menautkan dokumen ini sebagai acuan status.
2. **`docs/HANDOVER_AUDIT.md`** sudah ditandai `SUPERSEDED` dengan daftar bagian yang tidak lagi akurat (§1.1, §7, §10, §25, §32), dan baris tabel ringkasannya dikoreksi. Isinya tetap disimpan sebagai catatan kondisi kode sebelum refactor.
3. **Penamaan task di lokalisasi** sudah dirapikan: key task-level di `localization/languages/id.json` kembali berbunyi "Task" (`taskN`, `defaultTaskName`, `viewTasks`, `newTask`, `switchToTask`, `createTask`, `closeTask`, `moveToTask`, `nameTask`, `taskDeleteWarning`, `taskSettings`, `taskRename`, `taskDelete`, `returnToTask`, `appMenuNewTask`, `focusModeExplanation1`). Dua sisa di `en-US` juga ikut diperbaiki (`taskDeleteWarning` → "Task deleted", `returnToTask` → "Return to your previous task"). Nama default workspace dipisah ke key baru `defaultWorkspaceName` (`Workspace %n`) supaya tidak ikut berubah menjadi "Task".

Catatan kecil: key `taskN` tidak dipakai di mana pun di kode (tidak ada pemanggil `l('taskN')`), nilainya tetap diselaraskan agar tidak menyesatkan.
