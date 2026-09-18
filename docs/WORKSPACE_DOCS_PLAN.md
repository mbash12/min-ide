# Workspace Docs Plan

Branch: `feat/workspace-docs`

## Goal

Replace the unused HTTP Tester sidebar placeholder with a small Docs feature:

- the sidebar shows a document list for the selected workspace;
- creating a document stores Markdown as its canonical content;
- opening a document uses a full-width internal tab with a rich-text editor;
- switching workspaces shows only that workspace's documents;
- the workspace AI can use documents unless the user marks them private;
- data stays local to Min and survives restarts.

The first version should be reliable and pleasant for personal use, without collaboration, sync, permissions, or a general-purpose document platform.

## Product decisions

### Navigation

- Rename the `httptester` activity item and panel to `docs` instead of keeping compatibility aliases for a placeholder that never stored data.
- Keep the document list in the sidebar.
- Open a selected document in `min://app/pages/docs/index.html` as a regular internal tab. The sidebar is too narrow for a useful rich-text editor.
- Reuse an existing tab for the same `(workspaceId, documentId)` pair. Documents from two workspaces must never share a tab identity.

### Storage

- Add a `documents` collection to `custom_app_data.db` through `main/dbService.js`.
- Store one canonical `markdown` string, not editor HTML or an editor-specific JSON tree.
- Scope every list, get, update, and delete operation by both `workspace_id` and document `id`. Do not trust an ID by itself.
- Keep documents in Min's user data rather than writing `.md` files into the workspace folder. This supports workspaces without a folder and avoids surprising project-file changes.
- A document record should contain:

```js
{
  id: 'doc-...',
  workspace_id: '...',
  title: 'Untitled',
  markdown: '',
  private: false,
  created_at: 0,
  updated_at: 0
}
```

### AI access and privacy

- Documents are AI-readable by default. A visible **Private** toggle in both the sidebar row menu and editor header opts a document out.
- Add one workspace-scoped `docs` custom tool to `main/agentTools.js`. Do not inject document content, titles, summaries, counts, or other Docs metadata into the system prompt or conversation context automatically. The AI learns about Docs only when it explicitly calls this tool, and receives only that call's bounded result.
- Initial tool operations:
  - `list`: metadata for non-private documents in the current workspace;
  - `search`: title/content matches with short snippets from non-private documents;
  - `get`: full Markdown for one non-private document;
  - `create`: create a non-private document when the user asks the AI to record something;
  - `update`: update a non-private document when the user asks for an edit.
- Keep deletion and privacy changes UI-only in v1. The AI must not be able to delete documents, make a private document public, or change the privacy flag.
- Enforce privacy inside main-process document functions used by the AI tool. UI filtering alone is not a security boundary: `get`, `search`, and `update` must reject a private record even when its ID is supplied directly.
- Bind the tool to the agent session's captured `workspaceId`, exactly like Browser and Playbook tools. Do not accept an arbitrary workspace ID from model parameters.
- Limit list/search result counts and return metadata/snippets before full content so a large docs collection does not flood model context.
- Marking a document private blocks future tool calls immediately. It cannot remove text already returned into an existing AI conversation; the UI should explain that starting a new chat is required to clear prior conversation context.

### Editor

- Use Toast UI Editor in WYSIWYG mode for a polished Markdown editing experience with a built-in toolbar and dark theme.
- Save Markdown directly from the editor, avoiding a separate editable-HTML conversion layer.
- Support the practical Markdown subset first: paragraphs, headings, bold, italic, strike, links, ordered/unordered lists, blockquotes, inline code, fenced code blocks, and horizontal rules.
- Provide a compact sticky toolbar plus keyboard shortcuts for the common formatting actions.
- Autosave with a short debounce (about 500 ms), show `Saving…`, `Saved`, and error states, and flush pending content before unload.
- Update the document title separately and reflect it in the Min tab title.
- Sanitize rendered HTML before inserting it. Never persist arbitrary HTML as the source of truth.
- Do not attempt lossless round-tripping for unsupported Markdown extensions in v1; document the supported subset and keep the serializer deterministic.

## Implementation sequence

### 1. Replace the placeholder shell

- Update `index.html`:
  - rename `sidebar-tab-httptester` / `sidebar-panel-httptester` to `docs`;
  - use a document/book Codicon;
  - remove the placeholder markup.
- Update `js/sidebar.js`:
  - register a new `sidebar/docsPanel.js` module;
  - replace the `httptester` tab identifier with `docs`;
  - keep Docs available for folderless workspaces, since storage is keyed by workspace ID rather than workspace path.
- Rename localization from `sidebarHttpTester` to `sidebarDocs` and add strings for empty, create, rename, delete, save, and error states.
- Add focused Docs styles to `css/sidebar.css` or a small `css/docs.css` included by the existing page.

### 2. Add workspace-scoped document persistence

- Extend the default state in `main/dbService.js` with `documents: []`; `Object.assign` already makes this backward-compatible for existing database files.
- Add IPC operations:
  - `db:listDocuments(workspaceId)` returning metadata only;
  - `db:getDocument({ workspaceId, id })`;
  - `db:createDocument({ workspaceId, title })`;
  - `db:updateDocument({ workspaceId, id, title?, markdown?, private? })`;
  - `db:deleteDocument({ workspaceId, id })`.
- Add main-only AI accessors that always apply `private !== true` before returning content or accepting an update. Do not expose a generic bypass flag through IPC.
- Validate non-empty workspace IDs, cap title/content sizes to reasonable local limits, and return `{ ok, document?, error? }` consistently.
- Preserve `created_at`; change `updated_at` only on successful updates.
- Add matching wrappers to `js/util/customDataStore.js`.

### 3. Build the sidebar document list

- Create `js/sidebar/docsPanel.js` following the proven workspace event pattern in `fileTree.js` and `agentPanel.js`.
- On `workspace-selected` and `task-selected`:
  - capture the selected workspace ID;
  - clear stale rows immediately;
  - load the new workspace list with a sequence token so late responses cannot overwrite the current workspace.
- UI states:
  - header with Docs title, add, and refresh actions;
  - rows sorted by `updated_at` descending;
  - empty, loading, and recoverable error states;
  - row actions for rename and delete;
  - a lock indicator and Private toggle;
  - confirmation before delete.
- Clicking a row calls a dedicated `docsView.open(workspaceId, documentId, title)` helper.
- After create, open the new document immediately. Refresh the list after create, rename, delete, and editor save events.

### 4. Add Docs internal-tab lifecycle

- Create `js/docsView.js`, modeled on the useful parts of `editorView.js` but kept separate from file editor semantics.
- Encode `workspace` and `doc` in the internal URL and use both when finding/reusing a tab.
- Add helpers for `isDocsURL`, `getDocumentIdentity`, `findTab`, and `open`.
- Do not use preview-tab replacement in v1; document tabs are cheap and explicit.
- Add a preload relay in `js/preload/docs.js` (or extend the existing safe DB relay) so the sandboxed Docs page can only invoke the five document IPC operations.
- Include the relay in `scripts/buildPreload.js`.
- Ensure tab closure and workspace deletion do not leak listeners. A Docs tab may remain open while another workspace is selected, but its URL-bound workspace identity must continue to control all reads/writes.

### 5. Build the rich-text page

- Add:
  - `pages/docs/index.html`;
  - `pages/docs/docs.js`;
  - `pages/docs/docs.css`.
- Read `workspace` and `doc` from the page URL, then fetch through the scoped IPC API.
- Render sanitized Markdown into a `contenteditable` surface.
- Implement toolbar commands and predictable selection restoration.
- Convert editor HTML to Markdown on change, debounce saves, and ignore stale save responses with a monotonically increasing revision.
- Show the Private toggle in the editor header and persist it independently from the debounced content save so access revocation is not delayed.
- Report title/save changes to the host so the tab label and sidebar metadata update without polling.
- Handle load failure, deleted-document, and save failure states without replacing unsaved editor content.

### 6. Integration polish

- Make sidebar list refresh events include `workspaceId` and ignore events from other workspaces.
- Make deletion close an open matching Docs tab only after confirmation; if close coordination becomes invasive, show a deleted state in that tab and leave automatic close for later.
- Confirm Docs behaves correctly with sidebar resizing, split views, workspace switching, archived workspaces, and app restart.
- Update the sidebar module comment and any Pro feature copy that still mentions HTTP Tester.

### 7. Expose non-private Docs to the workspace AI

- Add document helper functions to `main/dbService.js` for AI list, search, get, create, and update operations. Every read/write helper receives the session workspace ID and enforces it internally.
- Extend `main/agentTools.js` with a compact `docs` tool using an `operation` parameter, following the existing Playbook tool pattern.
- Tool guidance should tell the model to:
  - search/list before reading unless the user names a specific document;
  - call `get` only for documents relevant to the task;
  - create/update only when the user requests a persistent documentation change;
  - treat a private/not-found result as unavailable and never try to infer or bypass it.
- Do not add Docs to agent-session initialization, context snapshots, chat restoration, or prompt guidelines beyond advertising that the `docs` tool exists.
- Return Markdown as text for `get`; return bounded JSON metadata/snippets for list/search/create/update.
- Emit a workspace-tagged `docs-changed` event after AI create/update so the sidebar and any open Docs tab refresh without polling or cross-workspace bleed.

## Verification

### Automated and static checks

- Add focused tests for document CRUD isolation:
  - two workspaces can use the same title without collision;
  - cross-workspace get/update/delete is rejected;
  - update preserves `created_at`;
  - old database files without `documents` load as an empty list.
- Add AI privacy tests:
  - list and search omit private documents;
  - direct get/update by a private document ID is rejected;
  - the tool cannot address another workspace;
  - AI-created documents default to non-private;
  - privacy changes are not accepted through AI tool parameters.
- Add small serializer fixtures for every supported Markdown construct and a sanitize test for scripts/event attributes.
- Run changed-file Standard lint, `node --check` for new JavaScript, `git diff --check`, and `npm run build`.

### Manual acceptance flow

1. In workspace A, create two documents and format headings, lists, links, inline code, and a code block.
2. Reload Min and confirm content and ordering persist.
3. Switch to workspace B and confirm A's documents are absent.
4. Create a document in B, leave its tab open, switch to A, then edit the B tab; confirm the save remains scoped to B.
5. Open the same document twice and confirm the existing tab is focused.
6. Rename and delete documents; confirm sidebar and open-tab states stay coherent.
7. Simulate a save error and confirm the editor keeps the unsaved content and clearly reports the failure.
8. Ask the workspace AI to list, read, create, and update a normal document; confirm sidebar/editor refresh.
9. Mark a document private and confirm it disappears from AI list/search and direct get/update is rejected.
10. Switch workspaces and confirm the AI cannot discover documents from the previous workspace.

## Explicitly out of scope for v1

- cloud sync, sharing, collaborative cursors, comments, permissions, or version history;
- folders, tags, search, backlinks, templates, attachments, embeds, or slash commands;
- importing/exporting project `.md` files;
- arbitrary HTML preservation or every Markdown extension;
- injecting any document content or metadata into AI context without a `docs` tool call, or retroactively removing content from existing chat history;
- mobile layout and corporate audit/compliance requirements.

## Suggested commit slices

1. `feat(docs): replace HTTP tester placeholder with workspace document list`
2. `feat(docs): add workspace-scoped document persistence`
3. `feat(docs): add rich-text markdown editor tab`
4. `feat(docs): expose non-private workspace docs to AI`
5. `test(docs): cover storage isolation, privacy, and markdown conversion`
