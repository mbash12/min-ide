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
| 2 | Core hierarchy | — bersih |
| 3 | Favicon | — bersih |
| 4 | Workspace model | DITUNDA — `sidebarState` |
| 5 | Workspace switching | — bersih |
| 6 | Workspace persistence | — bersih |
| 7 | Archive Workspace | DITUNDA — auto-unpin (§22) |
| 8 | Missing workspace path | — bersih |
| 9 | Profiles | — bersih |
| 10 | Profile switching | — bersih |
| 11 | Clear Profile Data | — bersih |
| 12 | Central database | MISSING — sebagian besar tabel; DIFFERENT — JSON, bukan DB |
| 13 | Tabs | — bersih |
| 14 | Monaco editor | — bersih |
| 15 | Terminal | — bersih |
| 16 | Documents | — bersih |
| 17 | Notes | — bersih |
| 18 | Sidebar | — bersih |
| 19 | File Tree | — bersih |
| 20 | Git | — bersih |
| 21 | Tile / Split View | — bersih |
| 22 | Pinned Tasks | DITUNDA — arah diubah ke pinned tab |
| 23 | Download preference | DITUNDA — tidak Task-scoped |
| 24 | AI coding agent | DIFFERENT — hanya OpenRouter |
| 25 | AI session model | DIFFERENT — history per Task, bukan per Workspace; MISSING — ownership |
| 26 | Browser control | — bersih |
| 27 | Extra settings page | — bersih |
| 28 | Startup behavior | — bersih |
| 29 | Task deletion | DITUNDA — pinned task (§22), download preference (§23) |
| 30 | Workspace deletion | DITUNDA — pinned task (§22) |
| 31 | Architecture guidelines | DIFFERENT — duplikasi store, global swap, tanpa `ide/` |
| 32 | Upstream compatibility | DIFFERENT — footprint core besar (remote sudah benar) |
| 33 | Implementation order | Sebagian fase belum lengkap |
| 34 | Non-goals | — dipatuhi |
| 35 | Coding-agent working rules | VIOLATION — 3 aturan |
| 36 | Definition of success | 2 dari 14 langkah belum penuh (keduanya diterima) |

Dua hal yang paling sering muncul sebagai akar gap: **tab metadata tidak ada** (§13, §26, §31) dan **AI session ownership tidak dimodelkan** (§25, §29, §30).

---

## §2 Core hierarchy

Seluruh anggota model kini ada. **Task-scoped preferences** diimplementasikan sebagai `task.prefs` — map key/value JSON di record task yang ikut whitelist restore (`js/tabState/task.js`) dan tersimpan lewat session restore biasa. API-nya modul `js/taskPrefs.js` (`get`/`getAll`/`set`, hapus key dengan nilai null), resolve task lintas workspace lewat `workspaces.findTask`/`findWorkspaceContainingTask`. Belum ada konsumen — siap dipakai, mis. session id agent per task (§25). Diverifikasi: prefs serialize → restore → clear semuanya round-trip.

Hierarki `Workspace → Task → Tab` itu sendiri sudah nyata (bukan lagi alias).

---

## §4 Workspace

- **DIFFERENT** — `sidebarState` dan `activityBarVisible` bukan field workspace seperti di blueprint, melainkan disimpan terpisah di IndexedDB dengan key `workspace:<id>` (`js/util/uiStateDB.js:13-16,44-60`; ditulis dari `js/sidebar.js:204-221`). Fungsional tetap persisten per workspace, tapi bukan bagian dari data model workspace.
Kepemilikan nama default sudah dipisah dengan benar: task memakai `defaultTaskName`, workspace memakai `defaultWorkspaceName` (`js/workspaceDrawer/workspaceDrawer.js:161,220,466`).

---

## §5 Workspace switching

Task terakhir, tab terakhir, tiled state, sidebar state, dan runtime yang tetap hidup sudah sesuai.

---

## §6 Workspace persistence

Notes kini dipersist — di collection `notes` milik `dbService`, yang memang global sesuai blueprint (bukan per workspace).
Pointer session aktif kini persisten (`main/agent.js`): `prefsByCwd` ditulis ke `<userData>/pi-agent/agent-prefs.json` dan dibaca lagi saat dipakai, jadi setelah restart sebuah task kembali ke percakapan yang tadi terbuka, bukan ke yang terakhir dimodifikasi (`resolveSessionFile` memeriksa `prefs.sessionPath` sebelum jalur heuristik `restoreRecent`). `skipRestore` ikut bertahan, sehingga pilihan "session baru" tidak berubah jadi restore otomatis. Entry dibuang saat workspace dihapus; archive tidak menghapusnya karena task-nya masih ada.

---

## §7 Archive Workspace

**DITUNDA (auto-unpin).** Langkah archive lainnya sudah berjalan: halaman di-unload, terminal dihentikan, dan live agent session dibuang (`js/browserUI.js:416-464`). Auto-unpin menunggu §22.

---

## §8 Missing workspace path

Seluruh requirement sudah sesuai. Folder yang hilang terdeteksi lewat `workspacePathStatus` (`main/fileTree.js`), dan `js/workspacePathStatus.js` menyimpan hasilnya per workspace dengan cache supaya pemeriksaan tidak diulang pada tiap refresh sidebar. Workspace seperti itu diperlakukan sebagai browser-only: Files/Git disembunyikan dan barisnya menampilkan ikon peringatan berikut tooltip (`js/workspaceDrawer/workspaceDrawer.js`, `css/workspaceDrawer.css`). Stored path tidak pernah dihapus otomatis dan tetap bisa diganti lewat Workspace Settings.

Dua keputusan yang sengaja diambil: selama pemeriksaan belum selesai statusnya dianggap **usable**, sehingga folder yang valid tidak pernah berkedip tersembunyi; dan bila pemeriksaan itu sendiri gagal (IPC error), status juga dianggap usable — lebih baik menampilkan file yang mungkin baik-baik saja daripada menyembunyikannya.

---

## §9 Profiles

Seluruh requirement sudah sesuai. Profile manager menyediakan Create, Rename, **Clear Data**, dan Delete (Duplicate bersifat opsional di blueprint dan tidak dibuat). Default Profile selalu tampil, tidak bisa dihapus, tapi datanya bisa di-clear — baris Default punya tombol Clear Data sendiri.

Delete kini **diblokir** selama profile masih dipakai workspace — termasuk workspace archived, karena assignment-nya masih hidup. `profileDeleteRequested` memeriksa `getProfileUsageWorkspaces` di `js/browserUI.js`; bila terpakai, halaman menerima `reason: 'in-use'` beserta daftar nama workspace dan menampilkannya sebagai notice. Jalur `applyProfileDeleted` (pindah ke default + recreate views) tetap ada sebagai jaring pengaman untuk race antara cek dan penghapusan.

---

## §10 Profile switching

Seluruh requirement sudah sesuai. `setWorkspaceProfile` (`js/browserUI.js`) sekarang hanya membongkar view **web tab** — partition adalah webPreference saat create dan tidak bisa ditukar pada webContents hidup, jadi view web dihancurkan lalu dibangun ulang lazy di partition baru. Editor (Monaco), terminal (PTY ikut hidup karena `webContents`-nya tidak dihancurkan), documents, notes, task, dan layout split semuanya tidak berubah: `webviews.destroy` mendapat opsi `preserveSplit` sehingga group tidak dibongkar, dan `splitView.showSplit`/`switchToTab` membangun ulang view yang hilang. Tab private dilewati karena memakai partition per-tab sendiri, bukan milik profile — tidak ada data profile lama yang bisa bocor lewat mereka. Untuk workspace yang tidak sedang dipilih, view web-nya (kalau ada) dihancurkan dan tercipta kembali saat workspace dibuka.

---

## §11 Clear Profile Data

Seluruh requirement sudah sesuai. UI ala Chrome ada di Pro Settings > Profiles: tiap baris (termasuk Default) punya tombol Clear Data yang membuka dialog pemilihan jenis data — **cookies & site data** (localStorage/IndexedDB/service workers ikut, situs logout) dan **cached images & files** (`clearCache` + auth/host-resolver cache). Request melewati relay `profileClearDataRequested` → `js/browserUI.js` `clearProfileData` → IPC `clearProfileData` di `main/remoteActions.js`, yang memvalidasi partition (`persist:webcontent` atau `persist:profile-*`) sebelum membersihkan.

Cascade ke live workspace terpenuhi: setelah partition dibersihkan, setiap **web tab** yang hidup di semua workspace pemakai profile itu di-`reload` (`webviews.callAsync(id, 'reload')`), sehingga logout langsung terlihat. Tab internal (editor/terminal/docs/notes) tidak disentuh, dan tab yang belum punya view otomatis memakai partition bersih saat dibuka. Bang global `!clearhistory` tetap ada dan tidak berubah.

---

## §12 Central database

- **DIFFERENT** — Yang ada bukan database melainkan **satu file JSON**. `main/dbService.js` menyimpan seluruh state di objek in-memory dan menuliskannya atomik sebagai `custom_app_data.db` (`main/dbService.js:22-31,150-158`). `CENTRALIZED_SQLITE_PLAN.md` belum dijalankan.
- **MISSING** — `workspaces`, `workspace_state`, `task_extra_state`, dan `tab_extra_metadata` tidak ada di DB. State workspace/task/tab ditulis ke `sessionRestore.json` + `localStorage['taskRestoreData']` (`js/sessionRestore.js:19-61`). Permukaan IPC DB hanya mencakup preferences/profiles/snapshots/designs/documents/notes/activities (`main/dbService.js`).
- **DIFFERENT** — `profiles` disimpan utama di `localStorage['workspaceProfiles']`; DB hanya mirror sekunder (`js/profiles.js:11-44`; `pages/proSettings/proSettings.js:147-164`).
- **DIFFERENT** — `sidebar_state` tidak di DB melainkan di IndexedDB Dexie (`js/util/uiStateDB.js:13-29,44-60`).
- **MISSING** — `tile_state` tidak punya storage sama sekali. (`notes` kini ada sebagai collection tersendiri — lihat §17.)
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

Seluruh requirement sudah sesuai, termasuk persistence archive/restart ala VS Code. `main/terminal.js` menyimpan session record per tab id — `tail` (rolling output, maks 128KB), `cwd`, `shell` — yang bertahan saat view dihancurkan (archive/switch) dan hanya dibersihkan saat tab benar-benar ditutup (`terminal-tab-gone`). cwd live dibaca dari proses pty (`/proc/<pid>/cwd` di Linux, `lsof` di macOS, best-effort null di platform lain). `js/terminalView.js` mem-poll `terminal-get-state` tiap 15 detik dan menulis `{resource: cwd, terminalScrollback, terminalShell}` ke record tab — yang sudah ikut dipersist session restore. Saat view dibuat ulang, `getViewResourceFor` membawa `extra.scrollback`/`extra.shell` → `minViewResource.extra` → halaman menulis ulang scrollback lalu spawn shell baru di cwd terakhir; seed yang sama dikembalikan ke main supaya tail tetap memuat seluruh history, bukan hanya output proses baru. Tombol Restart sengaja tidak membawa seed (session baru = buffer bersih). Diverifikasi headless: cwd live berubah setelah `cd`, tail berisi seed+output, record terhapus saat tab ditutup.

PTY nyata, session per tab, default cwd, dan berhenti saat tab/task/workspace dihapus atau di-archive sudah sesuai.

---

## §16 Documents

Seluruh requirement sudah sesuai. Tool AI tetap **satu tool `docs` bergaya group** (seperti `browser`/`playbook`/`figma` — keputusan sengaja supaya katalog tool agent tidak menggembung), tetapi operation-nya kini memakai nama blueprint verbatim: `operation: listDocuments | readDocument | editDocument` (`main/agentTools.js`). `listDocuments` mencakup list + `query` untuk search, `readDocument` membaca satu dokumen by id, `editDocument` membuat dokumen tanpa `id` dan meng-update dengan `id`. Konten tidak pernah diinjeksikan ke context — AI harus memanggil secara eksplisit.

Mermaid kini terverifikasi jalan di kedua mode. `mermaid@11` dimuat halaman editor sebagai script polos (`mermaid.min.js`, CSP `script-src 'self'` lolos); glue dibagi lewat `window.MinMermaid`/`MinMermaidPlugin` di `dist/docs-editor.js` (`pages/docs/editorBundle.js`). Mode Markdown: blok ` ```mermaid ` di preview kanan di-swap jadi container `.mermaid`. Mode WYSIWYG: plugin PM menyisipkan `Decoration.widget` tepat setelah code block — diagram tampil di bawah kode yang tetap editable, DOM widget dikelola ProseMirror sehingga tidak disapu rebuild nodeView (penyebab hilangnya render sebelumnya), dan key widget membawa hash source sehingga svg di-reuse selama source tidak berubah. Render memakai `mermaid.render(id, text)` (temp element di `document.body`, kebal detach Toast UI) yang terserialisasi per window; pane tersembunyi di-skip karena `getBBox` dagre gagal di situ.

---

## §17 Notes

Seluruh requirement sudah sesuai. Notes **global** — collection `notes` di `dbService` tidak membawa `workspace_id`, sehingga tidak ikut tersapu `db:deleteWorkspaceData` dan daftarnya sama di semua workspace (`main/dbService.js` seksi `--- Global Notes ---`; klien `js/util/customDataStore.js`). Editor-nya Toast UI yang sama dengan Documents — `pages/notes/` memakai `dist/docs-editor.js`, markdown WYSIWYG dengan tombol switch ke source, dan autosave berjalan lewat jalur yang sama.

Tab notes adalah tab Min biasa dengan `kind: 'note'` dan `resource` = note id; URL-nya generik (`min://app/pages/notes/index.html`, tampil sebagai `min://notes`) dan id sampai ke halaman lewat `minViewResource` (`js/notesView.js`, `pages/notes/notes.js`). Satu note paling banyak satu tab di seluruh workspace — membuka note yang sudah terbuka memfokuskan tabnya (pindah workspace/task bila perlu); menghapus note menutup tabnya di mana pun ia berada, termasuk membersihkan `splitState` task yang memuatnya.

Aturan "AI tidak boleh punya akses ke Notes" kini terpenuhi **secara struktural**, bukan trivial: collection notes tidak punya helper `*ForAI`, tidak masuk `minDocumentStore`, tidak ada tool agent untuknya, allowlist `dbInvoke` di `settingsPreload` tidak mencakup channel notes, tab `kind: 'note'` tidak memenuhi filter `isWebTab` browser control, dan browser control tidak punya aksi eval-JS yang bisa menyuntik `notes-invoke`. Broadcast `notes-changed` hanya membawa `noteId`, tanpa judul/konten.

---

## §18 Sidebar

Seluruh requirement sudah sesuai. Aktivitas `notes` kini ada di activity bar (`index.html:278-284`, panel `index.html:302`) dan tidak masuk `pathTabs`, jadi tetap tampil untuk workspace tanpa path — sesuai daftar blueprint (`AI, Documents, Notes` tetap tampil). Dua aktivitas di luar blueprint (`playbook`, `design`) tetap ada sebagai kelebihan, bukan gap.

Yang sudah sesuai: Files/Git disembunyikan saat tanpa path, Docs/Notes tetap tampil tanpa filesystem, panel mendorong konten lewat margin (bukan overlay), dan state persisten per workspace.

---

## §20 Git

Semua item sudah ada, termasuk **diff working tree**: klik baris file menampilkan diff-nya di bawah baris itu lewat `ipc.invoke('gitDiff', …)` (`js/sidebar/gitPanel.js`), dengan satu diff terbuka pada satu waktu. Renderer diff dipakai bersama dengan tampilan commit (`renderDiffRows`). Untuk file untracked panel menampilkan catatan agar di-stage dulu, karena git tidak punya pembanding sebelum itu; "Open File" tetap tersedia di menu klik-kanan baris.

Item §20 lainnya sudah ada, termasuk deteksi repo untuk workspace di subfolder (`main/git.js:58-77,199-216`), stage/unstage, commit, branch, checkout, pull/push/sync, conflict indicator, dan refresh.

---

## §21 Tile / Split View

Seluruh requirement sudah sesuai: maksimal 3 panel, columns only, semua tipe tab bisa ditile, divider resizable (satu divider per gutter, `js/splitViewDivider.js`), width dan tiled relationship dipersist per task (`fractions` + field `splitState`), association antar tab (bukan pane entity), satu tab hanya di satu association, `A+B+C → A+C` saat satu pane di-untile atau ditutup, dan relationship otomatis hilang begitu tinggal satu tab.

---

## §22 Pinned Tasks

**DITUNDA — dan arahnya diubah.** Blueprint meminta *Pinned Task* (contoh: `Workspace A / Task Development`) dan menegaskan "Tidak ada pinned tab". Yang diinginkan justru sebaliknya: **pinned tab** — slot global maksimal 9 lintas workspace & task, indikator `x/9` di navbar, popup Ctrl+Space untuk quick switch, dan Alt+1..9 untuk lompat langsung ke slot.

Implementasinya sudah pernah dibuat lengkap dan berfungsi, lalu dibatalkan atas permintaan dan tidak masuk commit mana pun. Detail keputusan dan kode yang disimpan: lihat **Ditunda** di akhir dokumen.

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

Seluruh seksi minimal kini ada di `pages/proSettings` (`min://proSettings` — variasi nama yang diizinkan blueprint): AI Provider, Profiles, **Editor** (font size, tab size, word wrap → `editorFontSize`/`editorTabSize`/`editorWordWrap`, dibaca Monaco di `pages/editor/editor.js`), **Terminal** (font size, shell override → `terminalFontSize`/`terminalShell`, dibaca xterm + `getShell` di `main/terminal.js`), **Workspace Defaults** (`defaultWorkspaceProfile` — preselect profil di modal workspace baru), dan **Documents** (`docsDefaultMode` — `initialEditType` editor Toast UI di Docs dan Notes). Settings disimpan lewat store `settings` biasa dan sampai ke halaman internal lewat channel `minViewResource.extra`; berlaku untuk tab yang baru dibuka. Perubahan workspace-specific tetap di modal workspace sesuai spec.

---

## §28 Startup behavior

Seluruh langkah sudah sesuai, termasuk restore active tab dan tiled set (layout split disimpan per task dan dipasang kembali saat task dipilih — `js/browserUI.js:520-521`), lazy restore, dan archived workspace yang tetap cold.

---

## §29 Task deletion

- **DITUNDA** — "remove pinned Task if pinned" menunggu §22.
- **MISSING** — **"remove task-scoped download preference"** — preferensi itu belum ada (lihat §23).

Item lain sudah berjalan: `closeTask` menghentikan agent session dan menghancurkan seluruh tab beserta view-nya (`js/browserUI.js:151-181`), dan PTY terminal mati saat `webContents`-nya dihancurkan (`main/terminal.js:81-84`).

---

## §30 Workspace deletion

- **DITUNDA** — "remove pinned Tasks" menunggu §22.

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

**Phase 4 — Development UX** — seluruh item selesai (autosave di Monaco dan Docs, tile/split view sampai 3 panel dan persisten per task, temporary editor tabs, Git sidebar).

**Phase 5 — Documents** — seluruh item selesai: Documents, WYSIWYG Markdown, source mode, Mermaid (preview + widget WYSIWYG, `mermaid.render` terserialisasi), dan Notes.

**Phase 6 — AI**
- providers (jamak) — **belum**: hanya OpenRouter (`main/agent.js:30-32,426,689`).
- workspace history — **belum**: history per Task (`main/agent.js:91-99,231-237`).
- AI sessions, task/session ownership, filesystem/shell agent, dan document tools selesai.

**Phase 7 — Browser control** — seluruh item selesai: action lengkap, isolasi per task, dan pembatasan "web tabs only" lewat `kind` (lihat §26).

---

## §34 Important non-goals

Tidak ada non-goal yang dilanggar. Verifikasi: tidak ada multi-window milik fork (`selectedInWindow` adalah upstream), tidak ada grid/nested tiling (columns only, maks 3 panel), workspace single-root (satu field `path`), Notes kini ada tetapi tidak ada code path AI ke Notes sama sekali (lihat §17), dan tidak ada cloud sync / account / marketplace / remote dev / mobile. `main/keychainService.js` adalah password manager bawaan Min (upstream), dan `main/permissionManager.js:58-80` adalah permission website (media/notifikasi/pointer lock), bukan permission enterprise.

---

## §35 Coding-agent working rules

- **VIOLATION (rule 4 — "jangan rewrite tab engine")** — Engine tab membawa banyak logika fork: split-pane attach/detach dan routing workspace dijalin ke `js/webviews.js:85,144-148,269-297,331-438` dan `main/viewManager.js:338-415,445-506`, serta bootstrap tab-state diganti di `js/tabState.js:1-17`.
- **VIOLATION (rule 2 & 7 — "reuse native behavior / jangan buat abstraction sebelum perlu")** — Kombinasi global swap `window.tasks` (`js/tabState/workspace.js:298-302`) plus modul kompensasi `js/util/followTaskList.js:1-9`, ditambah alias `window.WorkspaceList`/`window.TaskList` di `js/tabState.js:12-17`.
- **VIOLATION (rule 3 — "jangan rewrite Task")** — Ringan. `js/tabState/task.js` dekat dengan upstream, tetapi menambah `reorder()` non-upstream yang memancarkan `task-moved` (`js/tabState/task.js:178-185`) dan mengubah `isCollapsed` agar memakai `this` (`:171-176`).

---

## §36 Definition of success

| Langkah | Status | Bukti |
| --- | --- | --- |
| Launch → Workspace 1 + Task "Development" aktif | **Diterima** | Task pertama sengaja memakai penamaan default Min, bukan "Development" |
| Files sidebar menunjukkan project | **Diterima** | Workspace baru belum punya folder, jadi tab yang butuh path (Files/Git/Design) memang tidak aktif sampai path dipilih — perilaku ini yang diinginkan (`js/sidebar.js` `updatePathTabs`) |
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

Satu langkah yang belum penuh tinggal kepemilikan AI session (§25); dua langkah default saat pertama kali jalan sudah diputuskan untuk dibiarkan apa adanya.

---

## Sudah ditutup

Gap yang sudah dikerjakan setelah dokumen ini ditulis, dan tidak lagi dihitung di atas:

1. **§36 — pintu masuk terminal.** Terminal tab sebelumnya hanya bisa dibuat lewat bang `!term`. Sekarang ada `js/terminalView.js` (modul tunggal yang membuka terminal), item menu File > Open Terminal, dan keybinding default `addTerminal` (`ctrl+\``).
2. **Tile / split view sekarang persisten** (§5, §6, §21, §28). Layout disimpan per task sebagai field `splitState` (`js/tabState/task.js:49-52`), ditulis oleh `splitView.persist()` pada setiap perubahan group/ratio (`js/splitView.js`) dan dipasang kembali oleh `splitView.restoreForSelectedTask()` saat task dipilih (`js/browserUI.js:520-521`). Karena state-nya menempel di record task, ia ikut format session v3 yang sudah ada tanpa perubahan format. `clearAll()` sengaja tidak menulis apa pun: ia hanya membongkar tampilan, sehingga layout task tetap utuh saat kembali.
3. **Tile sampai 3 panel** (§21, §36). Group memegang 2–3 pane (`maxPanesPerGroup`), lebar tiap pane disimpan sebagai `fractions` yang selalu berjumlah 1, dan setiap gutter punya divider sendiri (`js/splitViewDivider.js`). Satu pane bisa dikeluarkan tanpa membubarkan group lewat "Remove from Split View" (`js/navbar/tabContextMenu.js`), dan menutup satu pane dari `A+B+C` menyisakan `A+C` tiled; group baru hilang saat tinggal satu pane.
4. **Metadata tab + URL internal generik** (§13, §26, §31). Tab membawa `kind` dan `resource`; URL editor dan terminal menjadi generik sehingga tidak ada path workspace di address bar maupun di session, dan resource sampai ke halaman lewat preload bridge. Browser control juga dibatasi ke tab `kind: 'web'` saja.
5. **Batch kecil**: autosave Monaco (§14), diff working tree di panel Git (§20), dan `createdAt`/`updatedAt` pada workspace (§4).
6. **Batch cepat lanjutan**: `action=read` untuk membaca teks halaman (§26), penghapusan berkas transkrip AI saat workspace dihapus (§30), dan prefill nama default di modal workspace (§4).
7. **Path workspace hilang** (§8). Folder yang sudah tidak ada membuat workspace jadi browser-only: Files/Git disembunyikan dan baris workspace menampilkan peringatan, tanpa menghapus path tersimpan.
8. **Notes** (§6, §12, §17, §18, §33, §34). Fitur lengkap: collection `notes` global di `dbService` + IPC `db:*Note*` (`main/dbService.js`), klien `customDataStore`, halaman editor `pages/notes/` (Toast UI yang sama, source mode aktif, autosave), bridge `js/preload/notes.js` (channel `notes-invoke`), tab `kind: 'note'` + `resource` via `minViewResource` dengan dedupe global lintas workspace (`js/notesView.js`), dan aktivitas `notes` di sidebar (`js/sidebar/notesPanel.js`, `index.html`, `css/sidebar.css`). AI tidak punya jalur ke notes secara konstruksi (lihat §17).
9. **Source mode Documents** (§16, §33). `hideModeSwitch` dilepas dari editor Docs, jadi tombol switch WYSIWYG ↔ Markdown kini tampil — editor Notes memakai konfigurasi yang sama.
10. **Mermaid** (§16, §33 Phase 5). `mermaid@11` terintegrasi di kedua surface editor: swap `pre` → `.mermaid` di preview Markdown, dan `Decoration.widget` ProseMirror di bawah code block WYSIWYG (kode tetap editable). Render lewat `mermaid.render` terserialisasi, guard pane tersembunyi, key widget = hash source untuk reuse DOM. Diverifikasi headless: render awal + re-render setelah edit source.
11. **Profile Clear Data + delete-blocking** (§9, §11). Dialog Clear Data per profile (termasuk Default) dengan pilihan jenis data; IPC `clearProfileData` memvalidasi partition dan membersihkan `clearStorageData`/`clearCache` sesuai pilihan; web tab hidup di workspace pemakai di-reload. Delete profile diblokir bila masih dipakai workspace (`in-use` + daftar nama). Diverifikasi headless: partition invalid/no-types ditolak, cookie nyata terhapus setelah clear.
12. **Profile switching hanya menyentuh web tab** (§10). `setWorkspaceProfile` tidak lagi `webviews.destroy` seluruh tab: hanya view web non-private yang dihancurkan dan dibangun ulang lazy di partition baru; editor/terminal/docs/notes/task/layout split bertahan (`webviews.destroy` punya opsi `preserveSplit`).
13. **Document tools selaras blueprint** (§16). Tool `docs` tetap satu group (katalog agent tidak menggembung), tapi operation-nya memakai nama blueprint verbatim: `listDocuments` (list/search), `readDocument` (by id), `editDocument` (create tanpa id / update dengan id).
14. **Terminal persistence** (§15). Session record per tab id di main (`tail` + `cwd` + `shell`); cwd dilacak dari proses pty (`/proc`/`lsof`), renderer poll menulisnya ke record tab yang dipersist session restore; scrollback digambar ulang saat restore lewat `minViewResource.extra`. Diverifikasi headless: cwd live setelah `cd`, tail menangkap output, record bersih saat tab ditutup.
15. **Extra settings sections** (§27). Empat tab baru di Pro Settings: Editor (font size/tab size/word wrap), Terminal (font size/shell), Workspace Defaults (profil bawaan workspace baru), Documents (mode editor bawaan). Preferensi sampai ke halaman internal lewat `minViewResource.extra`; shell dibaca langsung di main lewat `settings`.
16. **Task-scoped preferences** (§2). `task.prefs` — map key/value di record task, masuk whitelist restore dan ikut session restore; API `js/taskPrefs.js` (`get`/`getAll`/`set`) resolve lintas workspace. Siap jadi rumah untuk, mis., session id agent per task.

## Ditunda

**§22 Pinned Tasks** — ditunda, dan arahnya diubah dari blueprint.

Blueprint meminta *Pinned Task* (navigasi cepat ke `Workspace A / Task Development`) dan secara eksplisit menulis "Tidak ada pinned tab" (§22 dan §34). Keputusan yang diambil justru **pinned tab**, dengan bentuk:

- slot global maksimal **9**, lintas workspace & task (bukan per workspace);
- indikator **`x/9`** di navbar;
- **Ctrl+Space** membuka popup daftar pinned tab untuk quick switch, dengan navigasi 1–9 / panah / Enter di dalamnya;
- **Alt+1..9** untuk lompat langsung ke slot tanpa membuka popup;
- pin/unpin dari context menu tab;
- auto-unpin saat tab ditutup, task dihapus, workspace dihapus, atau workspace di-archive.

Implementasinya sudah pernah dibuat utuh dan lulus uji (registry dengan persistensi localStorage + validasi entri mati, panel popup, indikator, keybinding, hook siklus hidup), **tetapi tidak masuk commit mana pun** dan sudah dikembalikan dari working tree atas permintaan. Kodenya disimpan di stash git lokal supaya tidak perlu dirancang ulang:

```text
git stash list
stash@{0}: On master: experimental: pinned tabs (deferred, not for master)
```

Untuk melanjutkan: `git stash pop`. Kalau tidak diperlukan lagi: `git stash drop`.

Dua hal yang sudah diketahui dan sebaiknya diingat kalau dilanjutkan: `ctrl+space` bisa bentrok dengan IME di Linux (gampang diganti karena lewat keymap), dan popup-nya wajib memanggil `webviews.requestPlaceholder` saat tampil — view native menggambar di atas DOM renderer, jadi tanpa itu popup-nya tidak terlihat.

Karena §22 ditunda, tiga item yang bergantung padanya ikut ditunda: auto-unpin saat archive (§7), hapus pinned task saat task dihapus (§29), dan saat workspace dihapus (§30).

**§23 download per Task** — ditunda atas permintaan. Menyimpan direktori terakhir per task berarti download kedua dan seterusnya di task itu langsung tersimpan tanpa dialog (Electron hanya bisa memilihkan path lewat `setSavePath`, yang melewati dialog). Perubahan perilaku itu yang membuatnya ditunda, bukan kesulitannya. §29 ikut menunggu.

**§4 `sidebarState` sebagai field workspace** — ditunda, dan sebaiknya tidak dikerjakan. State itu sekarang ada di IndexedDB dan ditulis saat sidebar berubah; memindahkannya ke record workspace membuat setiap buka/tutup sidebar mengubah string state session, sehingga `sessionRestore.save` yang berjalan tiap 30 detik ikut menulis `sessionRestore.json` terus-menerus. Bebannya naik tanpa manfaat yang terlihat.

## Catatan

Tiga hal yang sudah ditutup bersamaan dengan dokumen ini, jadi tidak lagi terhitung sebagai gap:

1. **Banner `HANDOVER.md:3-5`** sudah diperbarui: menyatakan hierarki `Workspace → Task → Tab` sudah nyata, dan menautkan dokumen ini sebagai acuan status.
2. **`docs/HANDOVER_AUDIT.md`** sudah ditandai `SUPERSEDED` dengan daftar bagian yang tidak lagi akurat (§1.1, §7, §10, §25, §32), dan baris tabel ringkasannya dikoreksi. Isinya tetap disimpan sebagai catatan kondisi kode sebelum refactor.
3. **Penamaan task di lokalisasi** sudah dirapikan: key task-level di `localization/languages/id.json` kembali berbunyi "Task" (`taskN`, `defaultTaskName`, `viewTasks`, `newTask`, `switchToTask`, `createTask`, `closeTask`, `moveToTask`, `nameTask`, `taskDeleteWarning`, `taskSettings`, `taskRename`, `taskDelete`, `returnToTask`, `appMenuNewTask`, `focusModeExplanation1`). Dua sisa di `en-US` juga ikut diperbaiki (`taskDeleteWarning` → "Task deleted", `returnToTask` → "Return to your previous task"). Nama default workspace dipisah ke key baru `defaultWorkspaceName` (`Workspace %n`) supaya tidak ikut berubah menjadi "Task".

Catatan kecil: key `taskN` tidak dipakai di mana pun di kode (tidak ada pemanggil `l('taskN')`), nilainya tetap diselaraskan agar tidak menyesatkan.
