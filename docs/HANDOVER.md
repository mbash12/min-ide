# Min IDE Fork — Implementation Blueprint

> **Status: RENCANA, BUKAN AS-BUILT.**
> Dokumen ini adalah blueprint. Sebagian isinya belum diimplementasikan.
> Hierarki `Workspace → Task → Tab` (§2) **sudah nyata** — `Workspace` bukan lagi alias dari Task Min (§22 Pinned Tasks dan §25 AI session ownership kini punya fondasi untuk dibangun, meski keduanya belum ada).
> Daftar gap terkini (hanya yang kurang/berbeda dari blueprint, dengan bukti `file:line`): **[docs/HANDOVER_GAPS.md](docs/HANDOVER_GAPS.md)**.

## 1. Goal

Fork existing **Min Browser** dan tambahkan fitur IDE/development environment tanpa mengubah karakter utama Min sebagai browser minimal.

Target awal:

* Linux / Arch Linux.
* Single window.
* Personal use only.
* Local-only storage.
* Tidak perlu production-grade security, cloud sync, telemetry, migration framework kompleks, enterprise permission system, atau compatibility abstraction berlebihan.
* Tetap usahakan perubahan terhadap core Min seminimal mungkin supaya update upstream Min masih bisa di-merge secara berkala.

Prinsip utama:

> Min tetap browser. IDE features adalah layer tambahan di atas Min, bukan rewrite browser dari nol.

---

# 2. Core hierarchy

Gunakan model utama:

```text
Profile
  ↑
  └── digunakan oleh banyak Workspace

Workspace
  ├── profileId
  ├── optional rootPath
  ├── Task[]
  ├── Documents[]
  └── persisted UI state

Task
  ├── Tab[]
  ├── optional active AI session
  ├── tiled tab relationships
  └── task-scoped preferences

Tab
  ├── web
  ├── editor
  ├── terminal
  ├── document
  └── internal page lainnya
```

Workspace memiliki banyak Task.

Task adalah **Task Min yang sudah ada**, bukan konsep baru yang menggantikannya.

Tab sepenuhnya scoped ke Task.

Task tidak perlu mengetahui tab milik Task lain.

---

# 3. Favicon

Min saat ini menyembunyikan favicon.

Ubah supaya web tab menampilkan favicon seperti browser biasa.

Ini hanya modification terhadap UI browser dan bukan bagian dari IDE subsystem.

---

# 4. Workspace

Tambahkan konsep `Workspace` di atas Task.

Workspace fields minimal:

```ts
Workspace {
  id
  name
  profileId
  rootPath?: string

  archived: boolean

  activeTaskId
  sidebarState
  activityBarVisible

  createdAt
  updatedAt
}
```

Nama workspace default:

```text
Workspace 1
Workspace 2
Workspace 3
...
```

Tetapi langsung editable ketika creation modal dibuka.

Creation/edit Workspace menggunakan modal yang sama.

Fields:

```text
Name
Profile
Path (optional)
```

Profile hanya memilih existing profile.

Jangan buat profile otomatis dari workspace dialog.

Jika `rootPath` kosong:

```text
browser-only workspace
```

Jika ada:

```text
development workspace
```

---

# 5. Workspace switching

Buat Workspace drawer/switcher.

Ketika pindah Workspace:

* Task terakhir kembali aktif.
* Tab terakhir kembali aktif.
* tiled state kembali.
* sidebar state kembali.
* activity state kembali.
* editor/terminal/web runtime workspace sebelumnya tetap hidup.

Workspace non-active **tidak otomatis unload**.

Tujuannya supaya switching cepat.

---

# 6. Workspace persistence

Persist semua structural/UI state penting:

* workspace
* task
* tab
* tab ordering
* active task
* active tab
* tiled relationships
* tile width
* sidebar state
* selected activity
* activity bar hidden/visible
* workspace path
* profile
* internal tab metadata
* documents
* notes
* AI-related references

Setelah browser restart:

* buka Workspace terakhir
* Task terakhir
* tab/tiled set terakhir

Tetapi jangan restore seluruh runtime sekaligus.

Gunakan lazy restore seperti browser biasa.

Saat startup:

```text
restore metadata/layout
        ↓
load only currently visible/focused tabs
        ↓
other tabs loaded when focused
```

Webpage runtime state tidak perlu snapshot JS memory.

Normal browser restore behavior sudah cukup.

---

# 7. Archive Workspace

Archive digunakan untuk membebaskan memory.

Archive berarti:

```text
persisted = YES
live runtime = NO
```

Saat Workspace di-archive:

* unload semua webpage
* stop semua terminal process
* unload Monaco instances
* stop running AI agents
* release runtime objects
* pertahankan DB state
* auto-unpin semua pinned Tasks dari workspace itu

Saat workspace diaktifkan lagi:

perlakukan seperti browser setelah restart:

```text
restore structure/layout
lazy-load tab ketika diperlukan
```

Jangan otomatis membuka seluruh tab.

---

# 8. Missing workspace path

Jika `rootPath` sudah tidak ada atau tidak accessible:

jangan error fatal.

Anggap workspace sementara sebagai browser-only workspace.

Tampilkan indikator seperti:

```text
folder icon + slash/warning
```

Files / Git tidak tersedia.

User dapat membuka Workspace Settings dan memilih path baru.

Jangan otomatis menghapus stored path sebelum user menggantinya.

---

# 9. Profiles

Profile digunakan untuk isolasi website data.

Satu Workspace memiliki tepat satu Profile.

Satu Profile boleh digunakan banyak Workspace.

Isolasi kira-kira setara Chrome profile/container untuk website state:

* cookies
* localStorage
* IndexedDB
* cache
* permissions
* service workers
* website/session related state

Hal-hal browser non-site tetap global:

* bookmarks
* passwords
* autofill
* browser settings
* download history
* dll.

Buat satu:

```text
Default Profile
```

Default Profile:

* selalu tersedia
* tidak boleh dihapus
* datanya boleh di-clear

Profile manager mendukung:

```text
Create
Rename
Duplicate (optional/simple)
Clear Data
Delete
```

Profile tidak boleh dihapus selama masih digunakan Workspace.

---

# 10. Profile switching

Profile Workspace boleh diganti.

Ketika diganti:

* Task tidak berubah
* editor tidak berubah
* terminal tidak berubah
* documents tidak berubah
* layout tidak berubah

Tetapi semua web tab Workspace tersebut harus reload menggunakan storage/session partition profile baru.

Jangan biarkan data profile lama bocor.

---

# 11. Clear Profile Data

Buat UI mirip:

```text
Chrome Ctrl+Shift+Delete
```

User dapat memilih jenis data yang dihapus.

Jika profile digunakan oleh beberapa live Workspace:

clear langsung berlaku terhadap semuanya.

Web tabs yang terdampak harus reload/logout sesuai data yang dihapus.

---

# 12. Central database

Tambahkan centralized local database untuk extra features.

Tidak perlu cloud sync.

Tidak perlu distributed architecture.

Gunakan solusi DB yang cocok dengan stack Min/Electron.

DB menyimpan sekurangnya:

```text
workspaces
profiles
workspace_state
task_extra_state
tab_extra_metadata
documents
notes
sidebar_state
tile_state
AI references/config
provider configuration
```

Website storage tetap gunakan browser/Electron session partition, jangan pindahkan cookies/localStorage ke DB custom.

---

# 13. Tabs

Semua surface menggunakan tab system Min yang sama.

Tab types:

```ts
type TabKind =
  | "web"
  | "editor"
  | "terminal"
  | "document"
  | "internal";
```

Gunakan internal URL generik:

```text
min://editor
min://terminal
min://document
min://settings
```

Jangan expose resource sebenarnya di URL.

Contoh jangan:

```text
min://editor?file=/home/me/project/secret.ts
```

Resource sebenarnya disimpan di internal tab metadata:

```ts
{
  tabId,
  kind: "editor",
  filePath
}
```

Tujuannya supaya path workspace lain tidak terekspos lewat address bar.

---

# 14. Monaco editor

Tambahkan Monaco Editor sebagai internal tab.

File Tree membuka file ke Monaco.

Behavior mengikuti VS Code.

## Temporary / preview tab

Single click file:

```text
open temporary editor tab
```

Jika klik file lain:

```text
reuse temporary tab
```

Preview menjadi persistent jika:

* file diedit
* double click file

Jika file sudah dibuka di Task tersebut:

```text
focus existing tab
```

Jangan buka duplicate.

Scope hanya per Task.

Task lain boleh membuka file yang sama tanpa perlu mengetahui state Task sebelumnya.

## Save

Gunakan autosave dengan short delay.

Contoh:

```text
500–1000ms after change
```

Tidak perlu membuat complex dirty-buffer system.

---

# 15. Terminal

Tambahkan terminal tab:

```text
min://terminal
```

Setiap terminal tab adalah terminal session berbeda.

Gunakan real shell + PTY.

Default working directory:

```text
workspace.rootPath
```

Jika workspace tidak memiliki path, gunakan reasonable default shell directory.

Terminal process tetap hidup ketika:

* pindah tab
* pindah Task
* pindah Workspace

Terminal berhenti jika:

* terminal tab ditutup
* Task dihapus
* Workspace dihapus
* Workspace di-archive
* browser ditutup

Untuk archive/restart:

persist minimal:

* cwd
* scrollback/history jika feasible
* shell metadata

Tidak perlu benar-benar resume process.

Ketika terminal dibuka lagi, spawn shell baru dengan cwd terakhir.

Tidak perlu tmux kecuali implementasinya ternyata sangat mempermudah.

---

# 16. Documents

Documents scoped ke Workspace.

Document bukan file di filesystem.

Storage di centralized DB.

Format:

```text
Markdown
```

Editor:

* WYSIWYG markdown
* bukan split-view sebagai default
* tombol switch ke Source
* render Mermaid diagrams

Document digunakan sebagai context/helper material untuk AI.

AI tidak otomatis menerima document content.

Expose tool:

```text
listDocuments
readDocument
editDocument
```

AI harus eksplisit memanggil tool tersebut.

---

# 17. Notes

Notes hampir sama seperti Document tetapi:

```text
GLOBAL
```

Tidak scoped Workspace.

Gunakan editor yang sama:

* Markdown
* WYSIWYG
* source mode
* Mermaid

IMPORTANT:

AI **tidak boleh memiliki tool/read access ke Notes**.

Notes hanya untuk user.

---

# 18. Sidebar

Tambahkan sidebar ala VS Code.

Struktur:

```text
Activity Bar
+
Optional Sidebar Panel
```

Activity Bar dapat:

```text
shown
hidden completely
```

Ketika panel dibuka:

```text
sidebar pushes browser/content area
```

Jangan overlay web content.

Hanya satu activity sidebar aktif pada satu waktu.

Activities:

```text
AI Chat
Files
Git
Documents
Notes
```

Untuk workspace tanpa valid rootPath:

hide:

```text
Files
Git
Documents? NO
```

Correction:

Documents tetap Workspace feature dan tidak bergantung filesystem.

Jadi tanpa path hide:

```text
Files
Git
```

Tetap tampil:

```text
AI
Documents
Notes
```

Sidebar state persisted per Workspace.

Jika Activity Bar di-hide kemudian muncul lagi:

restore activity/sidebar terakhir.

---

# 19. File Tree

File Tree mirip VS Code.

Menampilkan:

```text
workspace.rootPath
```

Basic functionality cukup:

* tree
* expand/collapse
* create file/folder
* rename
* delete
* open
* refresh
* context menu dasar

Jangan overbuild VS Code Explorer.

Filesystem access untuk terminal/AI tidak perlu dibatasi hanya rootPath.

RootPath hanya default/project context.

---

# 20. Git

Git sidebar dibuat semirip mungkin dengan basic VS Code Source Control.

Detect repository berdasarkan workspace path, termasuk jika workspace berada dalam subfolder repo.

Support minimal:

```text
repository detection
changed files
diff
stage
unstage
commit
branch
checkout/switch
pull
push
sync
conflict indicator
refresh
```

Gunakan native git CLI/library sederhana.

Tidak perlu implement Git engine sendiri.

---

# 21. Tile / Split View

Referensi behavior:

```text
Vivaldi Tab Tiling
```

Tetapi implementasi disederhanakan.

Rules:

* maksimal 3 tabs
* hanya columns
* semua tab type bisa ditile
* divider resizable
* width persisted
* tiled relationship persisted

Example:

```text
[ Monaco ] [ Web Preview ] [ Terminal ]
```

Tiling bukan separate workspace/pane entity.

Ini association antar tabs.

Example:

```text
A + B tiled
C + D tiled
E normal
```

Klik A atau B:

```text
show A + B
```

Klik C atau D:

```text
show C + D
```

Klik E:

```text
show E only
```

Satu tab hanya boleh menjadi anggota satu tile association.

Jika:

```text
A+B+C
```

dan B di-untile:

```text
A+C
```

Jika tinggal satu tab:

tile relationship otomatis dihapus.

AI tidak perlu mengetahui tile system.

AI bekerja terhadap tabs, bukan visual layout.

---

# 22. Pinned Tasks

Single-window untuk sekarang.

Untuk quick navigation lintas Workspace, tambahkan **Pinned Task**.

Pinned Task bersifat global.

Contoh:

```text
Workspace A / Task Development
Workspace B / Task Docs
Workspace C / Task Dashboard
```

Pinned task dapat diakses dari mana saja.

Klik pinned Task:

```text
switch Workspace
→ switch Task
```

Tidak ada pinned tab.

Jika Workspace di-archive:

```text
auto-unpin semua Task workspace tersebut
```

Jangan auto-unarchive workspace.

---

# 23. Download preference

Download system/history tetap mengikuti browser biasa.

Tetapi last download directory bersifat **Task scoped**.

Example:

```text
Task A last download = ~/project/a/files
Task B last download = ~/Downloads
```

Download berikutnya di Task A menggunakan A.

Task B tidak terpengaruh.

Jika Task dihapus, preference ikut dihapus.

---

# 24. AI coding agent

Gunakan **pi.dev SDK**.

Agent adalah coding agent normal:

* filesystem
* edit file
* shell/tool execution
* repository interaction

Tambahan utama:

```text
browser control
```

Provider configuration bersifat global.

Support multiple providers.

AI session dapat memilih provider/model sendiri.

Provider/model session persistence sebisa mungkin gunakan behavior bawaan pi.dev.

API keys untuk sekarang boleh disimpan dalam local DB plaintext karena aplikasi hanya digunakan pribadi.

Jangan membuat secret-management infrastructure berlebihan.

---

# 25. AI session model

AI session history scoped ke Workspace.

```text
Workspace
  └── AI Sessions[]
```

Setiap Task:

```text
0 atau 1 active session
```

Satu session hanya boleh aktif di satu Task pada saat bersamaan.

Example:

```text
Workspace
  Task A → Session 1
  Task B → Session 2
  Task C → no session
```

Semua Task melihat Workspace AI history yang sama.

History UI harus menunjukkan:

```text
Session 1 — active in Task A
Session 2 — active in Task B
Session 3 — available
```

Session aktif di Task lain tidak selectable.

Untuk membebaskan Session 1:

Task A harus:

```text
create new session
OR
switch to another session
```

Session 1 lalu menjadi available untuk Task lain.

Ketika Task dihapus:

* active agent dihentikan
* AI session tidak dihapus
* session menjadi free
* history tetap ada

Ketika Workspace di-archive/browser ditutup:

* running agent dihentikan
* history/session persistence tetap ada

---

# 26. Browser control for AI

AI hanya dapat mengontrol **web tabs di Task tempat AI session aktif**.

Tidak boleh melihat/mengontrol web tabs dari:

* Task lain
* Workspace lain

Agent browser-control API harus mendukung sebanyak mungkin browser automation dasar.

Minimal:

```text
list web tabs
create web tab
close web tab
focus/switch web tab

navigate
back
forward
reload

inspect page
query elements
click
type
select
scroll

read page text/content
execute reasonable page interaction

upload
download
forms
keyboard/mouse-like interaction
```

Tujuan utamanya:

```text
development automation
web testing
debugging
agentic browser workflows
```

AI tidak perlu mengontrol:

```text
Monaco tab
Terminal tab
Document tab
Tile layout
Sidebar visual state
```

Untuk filesystem/terminal, gunakan coding-agent tools langsung.

Browser-control hanya untuk web pages.

---

# 27. Extra settings page

Tambahkan internal settings page untuk fitur fork.

Contoh:

```text
min://settings
```

atau section tambahan pada Min settings jika lebih mudah.

Sections minimal:

```text
Profiles
AI Providers
Editor
Terminal
Workspace Defaults
Documents
```

Jangan buat settings terlalu kompleks.

Workspace-specific settings tetap melalui Workspace modal:

```text
Name
Profile
Path
```

---

# 28. Startup behavior

Pada browser startup:

1. Load DB.
2. Restore workspace/task/tab metadata.
3. Restore Workspace terakhir.
4. Restore active Task.
5. Restore active tab/tiled set.
6. Load hanya tab yang diperlukan untuk tampilan awal.
7. Other tabs remain lazy.
8. Archived Workspaces tetap cold.

Jangan spawn:

* semua webviews
* semua terminals
* semua Monaco editors

saat startup.

---

# 29. Task deletion

Delete Task harus:

```text
close web tabs
stop terminal processes
close editor/document tabs
remove task-scoped UI state
remove task-scoped download preference
free attached AI session
remove pinned Task if pinned
```

Jangan menghapus:

```text
Workspace documents
Profile
AI session history
```

---

# 30. Workspace deletion

Delete Workspace harus:

```text
stop all runtime
delete tasks
delete tab state
delete tile state
delete workspace Documents
remove workspace AI history/state as appropriate
remove pinned Tasks
delete workspace DB records
```

Jangan menghapus Profile.

Profile lifecycle independen.

---

# 31. Architecture guidelines

Sebelum coding:

**inspect source Min terlebih dahulu.**

Cari:

```text
task implementation
tab lifecycle
webview/session handling
browser window
settings
state persistence
tab rendering
navigation/address bar
```

Jangan langsung membuat parallel browser architecture.

Reuse existing Min concepts sebanyak mungkin.

Prefer:

```text
Min core
   ↓
small integration hooks
   ↓
IDE modules
```

daripada:

```text
rewrite Min tab/task/browser stack
```

Extra feature source sebaiknya sebisa mungkin terorganisir, misalnya:

```text
src/
  ...
  ide/
    workspace/
    profiles/
    persistence/
    sidebar/
    editor/
    terminal/
    documents/
    git/
    ai/
    browser-control/
```

Sesuaikan dengan struktur repository Min sebenarnya.

Tidak perlu memaksakan struktur ini kalau tidak cocok.

---

# 32. Upstream Min compatibility

Repository fork harus tetap memiliki:

```text
origin   = personal fork
upstream = minbrowser/min
```

Tujuannya supaya update Min masih bisa di-merge.

Jangan over-optimize untuk zero-conflict upstream compatibility.

Cukup:

* kurangi perubahan core yang tidak perlu
* kelompokkan modifications
* hindari rewrite besar kalau extension cukup
* merge upstream secara periodik

---

# 33. Implementation order

Jangan implement semuanya sekaligus.

Kerjakan bertahap supaya fork selalu runnable.

## Phase 1 — Foundation

Implement:

```text
fork Min builds/runs
favicon visible
central DB
Workspace model
Profile model
Workspace drawer
workspace persistence
```

Pastikan:

```text
Workspace → Task → Tab
```

stabil dahulu.

---

## Phase 2 — Workspace runtime

Implement:

```text
workspace switching
restart restoration
archive
lazy restore
profile session isolation
workspace settings modal
pinned Tasks
```

---

## Phase 3 — IDE surfaces

Implement:

```text
Activity Bar
Sidebar
File Tree
Monaco
Terminal
```

Pastikan editor/terminal dapat hidup sebagai normal Min tabs.

---

## Phase 4 — Development UX

Implement:

```text
temporary editor tabs
autosave
Git sidebar
tile/split view
```

---

## Phase 5 — Documents

Implement:

```text
Documents
Notes
WYSIWYG Markdown
source mode
Mermaid
```

---

## Phase 6 — AI

Integrate pi.dev:

```text
providers
AI sessions
workspace history
task/session ownership
filesystem/shell agent
document tools
```

---

## Phase 7 — Browser control

Tambahkan agent browser API:

```text
tab management
navigation
page inspect
DOM interaction
forms
upload/download
automation
```

Enforce:

```text
agent can only access web tabs of its Task
```

---

# 34. Important non-goals

Jangan habiskan waktu membuat:

```text
multi-window support
cloud sync
team collaboration
account system
extension marketplace
remote development
mobile support
production credential vault
enterprise permissions
plugin ecosystem
complex migration system
perfect process snapshot/resume
AI access to Notes
nested/grid tile layouts
multi-root workspace
```

Ini personal development browser.

Prefer simple working implementation.

---

# 35. Coding-agent working rules

Saat mengimplementasikan:

1. Inspect existing Min implementation sebelum menentukan desain.
2. Reuse native Min behavior jika sudah ada.
3. Jangan rewrite Task.
4. Jangan rewrite tab engine kecuali mutlak diperlukan.
5. Buat perubahan kecil yang runnable.
6. Setelah setiap subsystem selesai, jalankan browser dan test behavior nyata.
7. Jangan membuat abstraction sebelum ada kebutuhan nyata.
8. Jika requirement dapat diselesaikan dengan library matang, gunakan library tersebut.
9. Jangan overengineer security karena aplikasi personal/local-only.
10. Tetapi jangan merusak Profile isolation atau Task AI isolation.
11. Keep upstream diff understandable.
12. Jika menemukan constraint Min/Electron yang membuat requirement sulit, pilih implementation paling sederhana yang mempertahankan UX/intention.

---

# 36. Definition of success

Fork dianggap berhasil jika workflow berikut bekerja:

```text
Launch browser

→ Workspace 1 terbuka
→ Task Development aktif

→ Files sidebar menunjukkan project
→ click source file
→ Monaco tab terbuka

→ open Terminal
→ shell berada di project root

→ open local/dev website
→ tile:
   Monaco | Website | Terminal

→ AI agent aktif pada Task tersebut
→ agent edit source
→ agent menjalankan command
→ agent mengontrol web tab untuk testing

→ create Task lain
→ AI session lain dapat berjalan paralel

→ switch Workspace
→ semua state Workspace sebelumnya tetap hidup

→ return
→ layout dan runtime masih sama

→ archive Workspace
→ runtime dilepas

→ reopen later
→ layout/task/tab state restored lazily

→ restart browser
→ active Workspace/Task/layout kembali
→ hanya tab yang diperlukan yang langsung di-load
```

Jika workflow tersebut nyaman dipakai sehari-hari, implementation sudah cukup.

Jangan mengejar parity penuh dengan VS Code, Chrome, atau Vivaldi.

Ambil behavior yang berguna dari masing-masing:

```text
Min      → minimal browser UX
VS Code  → editor/sidebar/git/temporary tabs
Vivaldi  → tab tiling
Chrome   → profile isolation/browser restore
pi.dev   → coding agent
```

dan gabungkan hanya bagian yang dibutuhkan.
