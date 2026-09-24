# Custom feature lifecycle and performance refactor

Branch: `refactor/custom-mods-stability`, based on `537be12e`.

This change preserves the existing controls, layouts, tool names and features.
It changes ownership lookup, asynchronous work, persistence and module boundaries
across the fork's workspace, agent, Git, Design and internal page features.

## Ownership and state

- `js/tabState/ownershipIndex.js` indexes tasks and tab owners, including across
  workspaces. Structural operations update the index before deferred events run.
  Each `TabList` also indexes its own records; ordered arrays remain the source
  for display order and serialization.
- `applyWindowEvent.js`, `workspaceSerialization.js` and `sessionSnapshot.js`
  separate remote event application, window transfer and disk snapshots.
  Remote events tolerate removed objects and do not echo remote reorder events.
- Deferred task events preserve reentrant emissions. Listener disposal and
  workspace destruction cancel obsolete queued work.
- `main/lib/window/tabStateRequests.js` correlates window initialization replies
  by request and source renderer. A closed or unresponsive source cannot leave
  the requesting window blocked indefinitely.
- `js/workspaces/` owns workspace and profile transitions. Cancelling a dirty
  editor close preserves its agent session and views. Background workspace
  operations preserve the selected workspace's split layout.

## Renderer work and internal pages

- Sidebar restoration has a selection revision and an in-memory workspace
  cache. User changes win over a pending restore; automatic path fallback does
  not overwrite a workspace before its saved layout arrives.
- Workspace drawer rows are reused by content signature and updates coalesce
  into an animation frame. Unchanged rows retain their DOM identity and scroll.
- `js/splitView/layout.js` owns geometry; `taskState.js` owns task persistence.
  Persistence timers are per task and cancelled on removal. A divider drag
  cannot alter a different task after selection changes.
- `js/webviews/tabEvents.js` routes page metadata through indexed ownership.
  Late background title, audio, reader and favicon work updates the owning tab.
  Native views retain attachments during unchanged selections and split resize.
- View generations reject obsolete page events. Main reports the actual
  generation when another window adopts an existing view. Pending method calls
  are bounded and results from replaced views are discarded. Popup adoption
  preserves the native OAuth opener; unadopted popups have bounded lifetimes.
- Favicon decoding is queued with replacement of pending work for the same tab;
  failed and stale images cannot block subsequent work. The color cache is bounded.
- `js/sidebar/lifecycle/` supplies request gates, coalescing and keyed writes to
  Docs, Notes, Playbook and Files. Folder searches are scoped to their renderer.
  Initial root loading and deleted-workspace write cancellation have regressions.
- Editor and Docs/Notes saves serialize revisions and drain newer edits after
  an in-flight write. External editor reads cannot overwrite newer edits.
  Editor CSP permits Monaco's local blob workers instead of forcing work onto
  the UI thread. Page teardown clears autosave and rendering timers.
- Terminal startup and output are tied to the current PTY record. Replaced PTYs
  cannot emit stale output/exit or overwrite a newer cwd. Background persistence
  is coalesced per tab and polling stops when there are no terminal tabs.

## Agent, Git, Design and Settings

- `main/lib/agent/` separates session coordination and event/history
  serialization. Same-context state reads do not cancel an initial prompt;
  incompatible context changes invalidate pending initialization. A renderer
  gets one agent destruction listener.
- `agentPanelLifecycle.js` protects selected-task responses and batches streamed
  Markdown rendering. Model catalog refreshes are coalesced and invalidated
  when provider configuration or the OMP runtime changes.
- `main/lib/git/` owns command construction and history decoding;
  `gitGraphView.js`, `gitRefreshGate.js` and `gitStatePersistence.js` own graph
  rendering, refresh scheduling and workspace persistence. Routine refreshes
  need fewer Git subprocesses and obsolete responses cannot replace a new scope.
- `designPanelLifecycle.js` and `designPanelExport.js` separate scoped requests,
  useful polling and export control. Stopping Figma invalidates a pending start
  so delayed startup cannot launch the child afterward. Hidden-engine behavior
  and existing export contracts are preserved.
- `main/lib/oauth/loopbackCallback.js` owns callback server teardown. Manual
  completion or cancellation closes an unused listener promptly.
- Pro Settings loads `profilesPanel.js` and `settingsLifecycle.js`. Provider
  discovery finishing after the Add Provider dialog opens now refreshes its
  options without clearing entered values or OAuth state. Existing model/OMP
  update controls and the provider list remain in place.
- Browser automation's serialized page DOM implementation moved to
  `main/lib/browser/pageDom.js`. `rendererRequests.js` validates reply ownership,
  bounds pending calls and cancels them when the target renderer closes.

## Storage and build

- `main/lib/storage/` separates schema, database opening, scoped prepared
  statements, transactional workspace cleanup and session backup writing.
  Access/busy errors no longer quarantine a database as corrupt. Proven corrupt
  databases preserve their companion files for recovery.
- Main owns both asynchronous and final synchronous session saves. An older
  staged JSON backup cannot overwrite the final close-time snapshot.
- Renderer UI-state operations serialize per key, including read/modify/write
  updates and cleanup. Queued writes cannot resurrect deleted workspace state.
- Browser builds serialize and coalesce watcher changes, publish an atomic
  bundle, and fail the command when bundling fails. Watchers include file
  addition/removal. Packaging explicitly includes runtime `main/lib` helpers.

## Verification

Run from the repository root with dependencies installed:

```sh
npm run build
npm run test:custom-mods
npm run test:custom-mods-smoke
npm run test:browser-visual
npm run test:google-auth
npm run benchmark:workspaces
```

The Electron runners accept extra flags after `--`; the local container required
`--no-sandbox`. The smoke runner uses an isolated disposable profile and hidden
window, with background throttling disabled for test determinism.

Validated on Electron 43.4.1:

- Full build and 136 Node regression tests pass.
- 17 browser integration checks and 12 native OAuth/popup checks pass.
- Full Min smoke passes with 4,001 tab records, 35 workspace/task switches,
  unchanged drawer row reuse, background and obsolete view events, and removal.
  It also opens Docs, Notes and files through the sidebar, checks autosave and
  editor pinning, runs/exits/restarts a real PTY, and opens the provider dialog.
  No uncaught renderer errors were observed.
- All newly added JavaScript files pass Standard and `git diff --check` passes.
  Repository-wide `npm test` still encounters existing lint/parser/global issues;
  it is not a clean repository-wide validation gate.
- The installed electron-builder file matcher retains the runtime helpers and
  their parent directories. Platform installers were not produced in this pass.

`benchmark:workspaces` compares the baseline and current state modules with
100 workspaces, 1,000 tasks, 20,000 tabs and 10,000 ownership/update/read operations.
The median of five local samples was **641.75 ms before, 8.49 ms after** (75.6x).
This measures that state path, not overall browsing speed, memory usage or the
number of simultaneously running page renderers. Results vary by machine.

Tests use local fixtures for provider/OAuth/Figma races. Live account login,
paid model calls and account-backed Figma exports were not repeated in this pass.
