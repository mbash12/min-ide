# Browser automation and repeatable UI tests

These tools run in **Min's own tabs** using its Electron WebContents and in-process debugger. They do not launch Chromium, Playwright, Puppeteer, a remote debugging port, or a Figma window. Restart Min after rebuilding to load the new tools.

## Locate, act, assert

The AI uses the existing `browser` tool. Actions inherit the calling task and workspace. `tabs` lists the available web tabs; editor, terminal, settings, and profile surfaces are excluded.

```json
{"action":"find","role":"button","name":"Save"}
{"action":"fill","label":"Email","value":"test@example.test"}
{"action":"check","testId":"terms","checked":true}
{"action":"click","role":"button","name":"Save"}
{"action":"assert","testId":"status","condition":"text","expected":"Saved","timeout":5000}
```

Locators combine `testId` (exact `data-testid`), `label`, `placeholder`, `role`, `name`, `text`, or `selector`. Name/label matching normalizes whitespace and ignores case; it is exact by default (`exact:false` allows a substring). Semantic names cover common labels, ARIA names, placeholders, and text; they are not a complete accessibility-tree implementation. Open shadow roots and same-origin frames are searched. Cross-origin frame contents and closed shadow roots are not inspected.

`find` returns a count and up to 10 matches (set `limit` up to 100), with refs, name, role, bounds, visibility, enabled/checked state, and non-password field values. `includeHidden:true` also finds hidden elements. `snapshot` remains useful for a page overview.

Actions require one visible matching target by default. An ambiguous locator fails with candidates. Refine it or use zero-based `nth`; `strict:false` chooses the first. An out-of-range `nth` never falls back to a different match. Refs are useful interactively and can re-resolve after rerenders; save stable locators in playbooks.

| Action | Behavior |
| --- | --- |
| `fill` | Replace an input, textarea, or contenteditable value; `value:""` clears it. Dispatches input/change for form controls. Rejects disabled/read-only fields. |
| `check` | Set a native checkbox/radio state; repeated calls do not toggle it. Uses a browser click when a change is needed, then verifies state. To uncheck a radio, select another radio. |
| `focus` | Focus the matching element. |
| `press` | Native browser keyboard events, including Tab, Enter, arrows, Backspace, and `Control+a`. A locator focuses that element first; without one, uses the current page focus. |
| `click` | Wait for a visible, stable, enabled element and check that its center is not covered, then dispatch browser pointer events. |
| `assert`, `wait` | Poll a condition until it passes or times out. The default timeout is 4 seconds, configurable from 0–15000 ms. |

Locating and assertions can poll. Mutating actions are **never automatically replayed**. Use assertions after actions to verify the resulting application state.

### Assertions

| `condition` | Expected value / meaning |
| --- | --- |
| `visible`, `hidden` | Visible target; or no visible matching targets. Hidden also passes if detached. |
| `attached`, `detached` | At least one match; or no matches in the DOM. |
| `text`, `value` | `expected` string. Text normalizes whitespace. Password values are redacted in results. |
| `checked` | `expected:true` or `false` (defaults to true). |
| `enabled`, `disabled` | Native disabled state or `aria-disabled`. |
| `count` | `expected` integer; counts matching attached elements, including hidden ones. |
| `attribute` | `attribute` name and `expected` string, or null for absence. |
| `css` | `property` such as `color` or `padding-left`, and exact computed `expected` string. |
| `url`, `title` | Page `expected` string; no locator. |
| `no-errors` | Immediately checks observed console/navigation/renderer errors; no locator. |

String assertions support `contains:true`; `not:true` negates conditions except `no-errors`. Missing elements never pass singular assertions such as `text` with `not:true`; use `hidden`/`detached` explicitly. `nth` selects one match before evaluating a condition. Failure results include expected/actual, attempts, and elapsed time.

`wait` with a condition has the same assertion behavior. Legacy `wait:{load:true}` waits for page load; fixed `ms` sleeps are still supported but condition waits make repeatable tests more reliable.

### Diagnostics and visual assertions

```json
{"action":"diagnostics","operation":"clear"}
{"action":"navigate","url":"http://localhost:3000"}
{"action":"assert","condition":"no-errors"}
{"action":"diagnostics","operation":"get"}
```

Observation starts when a tool first accesses the tab. Up to 200 bounded console/navigation/renderer messages are kept per tab. Clear explicitly for a fresh observation window; playbooks do this at each scenario start. If messages were dropped, `no-errors` fails because the record is incomplete. This is not a network request recorder or a retrospective log of errors before observation began.

For visual work, set `viewport`, then `screenshot`, `inspect`, or `compare`. See [visual tools](BROWSER_VISUAL_TOOLS.md) for image scale, crops, readiness, and compositor limits.

```json
{"action":"compare","referencePath":"/absolute/design.png","referenceScale":2,"maxMismatchRatio":0.01}
```

`threshold` controls the pixel color tolerance. `maxMismatchRatio` optionally adds a pass/fail limit for the fraction of changed pixels. The interactive result retains images and reports `assertion.passed`; `ok:true` means the comparison completed. A playbook automatically fails that step if `assertion.passed` is false, including if capture readiness timed out. It never updates the reference.

## Playbook format

A playbook is editable JSON in `.min/playbooks/<name>.json`, or workspace app data when there is no folder. Version 1 recipes remain readable; saving uses version 2.

```json
{
  "name": "save-profile",
  "description": "Save a profile and verify feedback",
  "vars": {"baseUrl":"http://localhost:3000", "email":"test@example.test"},
  "repeat": 3,
  "cases": [
    {"name":"desktop", "vars":{"width":1280,"height":800}},
    {"name":"mobile", "vars":{"width":390,"height":844}}
  ],
  "setup": [
    {"action":"viewport","width":"{{width}}","height":"{{height}}","dpr":1},
    {"action":"navigate","url":"{{baseUrl}}/profile"}
  ],
  "steps": [
    {"action":"fill","label":"Email","value":"{{email}}"},
    {"action":"click","role":"button","name":"Save"},
    {"action":"assert","testId":"status","condition":"text","expected":"Saved"},
    {"action":"assert","condition":"no-errors"}
  ],
  "teardown": [
    {"action":"viewport","operation":"reset"}
  ]
}
```

Adapt URLs, labels, and assertions to your app. Use setup to establish deterministic state and teardown for cleanup. All iterations share cookies, storage, and server data; the runner does not reset them automatically.

- Each iteration runs every case as `setup → steps → teardown`. Without cases, there is one default case. Teardown is attempted after step failures and cancellation.
- A failed step stops the remaining setup/body steps in that scenario unless `continueOnError:true`. Every failed step still makes the overall run fail. Later cases/iterations continue.
- `stepName` optionally labels a report step. `label` is always an element locator.
- Variables merge in order: saved defaults → case variables → run overrides. `{{variable}}` works recursively; an entire-field placeholder preserves numbers, booleans, or objects. Embedded placeholders become strings. Missing variables are rejected before browser actions start. Variable keys are literal, including dots.
- Up to 200 steps across all three phases, 20 repetitions, 20 cases, 100 scenarios, and 5000 planned steps per run. Only one playbook runs at a time.
- The task and initial web tab are pinned at run start. Explicit `tabs` new/select steps advance the active tab. Switching the user's selected task does not redirect later steps.
- Cancellation finishes the current action, skips remaining body steps, and runs teardown. It does not undo completed actions.

### AI operations

`playbook` supports `help`, `list`, `get`, `save`, `run`, `reports`, `report`, `cancel`, and `delete`.

For `save`, pass `setup`, `steps`, `teardown`, optional `repeat`, `vars` (default variable object), and `cases` (case array). For `run`, `vars` supplies overrides; `repeat` and `tabId` optionally override the saved count and initial tab.

```json
{"operation":"run","name":"save-profile","repeat":5,"vars":{"baseUrl":"http://localhost:3000"}}
{"operation":"reports","name":"save-profile"}
{"operation":"report","name":"save-profile","runId":"<id returned by run>","status":"failed","limit":10}
{"operation":"cancel","name":"save-profile"}
```

Legacy `varsJson` and `casesJson` inputs are still accepted. Structured objects avoid double-escaped JSON.

### Reports and sidebar

Reports and evidence are saved under `.min/playbooks/runs/<name>/<runId>/`. Each JSON report records run status, scenario and step outcomes, duration, assertion details, diagnostics, and screenshot/diff paths. Input variables are not copied wholesale into the report. Page URLs, assertion text, console messages, and screenshots can still contain application data.

Failure screenshots are best effort: if the tab has closed or its compositor cannot render, the report records the capture error while preserving the original failure. Reports remain on disk until removed; `reports` lists the latest 20, and older reports can still be read by run ID. The AI `report` operation returns 20 step results per page; filter with `status` and follow `nextOffset` to continue. `detail:"full"` returns complete step details for the page. The on-disk report retains every step and scenario.

The sidebar shows repetition count, progress, Stop, and the last result. Click the result to open the report. Edit the recipe to change saved defaults/cases or cleanup steps.

## Efficient tool use

- `browser {"action":"help","topic":"assert"}` returns just that action's fields and an example. Omit `topic` for the short workflow. Playbook and Figma also have `help`.
- Known locators can act directly. There is no mandatory full snapshot before every action.
- `snapshot` defaults to 80 interactive elements; `read` to 6000 characters. Both accept `selector` to scope a query and `offset`/`limit` for pages. `find` also returns `nextOffset`. Snapshot refs remain distinct across pages. Snapshot passwords are redacted.
- `inspect` uses compact related-element summaries. Request exact target CSS with `properties`, or `detail:"full"` when full ancestor/child styles and text rectangles are needed. Geometry is not rounded away.
- Diagnostics return 20 entries, prioritize errors, and retain total/dropped counts. Use `level:"error"` or `offset`/`limit`; `detail:"full"` uses chronological order.
- Visual `images:"auto"` includes screenshots, and only the diff image for changed comparisons. Matching comparisons emit metrics without images. `images:"all"` includes reference/actual/diff; `images:"none"` returns paths and metrics. Full-resolution artifacts remain available.
- JSON results have a 12,000-character default budget (30,000 for full detail). Oversized responses explicitly report `_output.truncated`, omitted fields, and `_output.fullResultPath` containing the complete returned data. If writing fails, the result says so. Use the builtin file reader for exact omitted data, or narrow/page the query. These artifacts live in `.min/agent-results` or workspace app data until removed.
- Figma `node-data` accepts `fields:"css,fonts,text"` to select required data. Workspace Docs `readDocument` accepts `offset`/`limit` and returns `nextOffset`.

### Short sequential batches

```json
{
  "action":"batch",
  "steps":[
    {"action":"fill","label":"Email","value":"test@example.test"},
    {"action":"click","role":"button","name":"Save"},
    {"action":"assert","testId":"status","condition":"text","expected":"Saved"}
  ]
}
```

Batch runs 1–12 known steps in a single tool call. It validates action names, fields, types, and required values for every step before browser mutations, pins task/tab, then executes sequentially. Runtime target/application failures stop execution immediately and preserve the failing expected/actual values. It reports `completed` and `stoppedAt`; earlier actions have already happened and are never automatically replayed. Nested batches and `continueOnError` are not allowed. Batch results contain image paths/metrics; use a standalone screenshot/compare for previews. Use playbooks for reusable scenarios, hooks, cases, and repetition.

### Measured catalog size

The four custom tools' serialized schemas, descriptions, snippets, and guidelines fell from **61,157 to 23,946 characters** (61% smaller), measured by `test:agent-tools`. Browser field schemas are no longer repeated in every playbook phase. Runtime step validation remains shared between standalone actions, batches, and playbooks. These are character counts, not a model-specific token estimate; image and tokenizer costs vary.

## Verification

- `npm run test:agent-tools`: catalog size budget, output bounds/recovery, image selection, action validation, batch failure semantics, reports, Figma field selection, and document pagination.
- `npm run test:playbook`: runner, variables, cases, reports, cancellation, scope tests.
- `npm run test:browser-visual`: real Electron integration, hidden offscreen WebContentsView, visual capture and comparison, locators, assertions, form actions, keyboard, diagnostics, and repeated playbook execution. Uses Min's installed Electron only.
