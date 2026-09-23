# Internal browser visual tools

Use the reference screenshot or Figma export as the source for visual layout.
Figma layers supply content, fonts, individual styles, and assets even when
grouping and Auto Layout are unreliable.

These actions extend the existing `browser` and `figma` tools. They operate on
Min's workspace-scoped Electron WebContentsViews through its in-process
debugger. They require no external browser, automation package, or debugging
port. Screenshot/export tool results include images for the model, plus local
artifact paths. Browser images are saved in `.min/design/shots` when a workspace
folder is available, otherwise in Min's `playbook-captures` directory.

## Workflow

```json
{"action":"viewport","width":1440,"height":900,"dpr":1}
{"action":"screenshot"}
{"action":"compare","referencePath":"/absolute/design.png","referenceScale":2}
{"action":"inspect","selector":".hero h1"}
{"action":"screenshot","selector":".hero h1"}
{"action":"compare","referencePath":"/absolute/design.png","referenceScale":2,"clip":{"x":80,"y":120,"width":600,"height":180}}
{"action":"viewport","operation":"reset"}
```

Call the examples above with the `browser` tool. `compare` sends the diff image
when pixels change and metrics only when they match. Use `images:"all"` for
reference, actual, and diff together, or `images:"none"` for paths/metrics only.
All three full-resolution files remain available. Inspect affected elements,
fix the UI, then compare again. The magenta diff marks pixels exceeding `threshold` (default
0.1, maximum RGB channel difference after compositing on white). The result
also reports mismatch ratio, mean absolute error, changed bounds, and up to
12 regions ranked by changed pixels. Antialiasing differences count. This
metric does not diagnose the cause or measure semantic design quality.

### Coordinates and scale

- `viewport` uses CSS pixels and an explicit DPR (default 1). `operation` can
  be `get`, `set`, or `reset`. It persists across navigation for that tab,
  independent of the native window size. A browser viewport takes priority
  over an overlay viewport; resetting it restores the overlay or window size.
- Browser `clip`, `inspect` x/y, element bounds, and diff regions use **viewport
  CSS pixels**. Captures also return `documentRect`, including page scroll.
  Element capture does not scroll automatically. Scroll first or choose a
  larger viewport if the element is outside the visible area.
- `referenceScale` is original reference image pixels per CSS pixel. Use the
  scale reported by Figma export, including any export scale clamping.
- By default, comparison uses the captured document rectangle in the reference
  image. The reference CSS width must match the viewport. A taller reference
  is allowed for comparison after scrolling.
- For a separately cropped reference, supply `referenceClip` in reference CSS
  coordinates. Its CSS dimensions must equal the captured area's dimensions.
  Only explicit pixel-density normalization is performed; images are never
  stretched to conceal a layout size mismatch.
- Model previews have a maximum edge of 1600 pixels; original PNGs remain at
  capture resolution. Each image's `previewToCSS` maps preview coordinates:
  `cssX = offsetX + imageX * scaleX`, and likewise for Y. Reference image
  mappings point into the reference; actual/diff mappings point into the tab.

## DOM inspection

`browser.inspect` accepts the existing selector/ref/role/text locators or x/y.
It returns bounding boxes, computed spacing/layout/colors/typography, three
ancestors, up to ten children (`limit` adjusts this), and Chromium's rendered
font information when available. Compact results summarize related elements.
Use `detail:"full"` for their complete styles and text rectangles. Use
`properties:"gap,font-size,color"` to retrieve only those computed properties
on the target, including custom CSS properties. Open shadow roots and
same-origin iframes are supported. Cross-origin frame internals cannot be
inspected through page DOM. Rotated/skewed iframe bounds are flagged as
approximate; capture them with an explicit rectangle.

## Geometric Figma lookup

Call with the `figma` tool after connecting the file from the Design sidebar:

```json
{"action":"inspect-region","nodeId":"12:34","referenceScale":2,"region":{"x":160,"y":240,"width":400,"height":100},"limit":12}
```

`nodeId` must be the exported root. `region` uses **original export pixels**,
before any preview reduction. Results include frame-relative bounds, CSS,
text, font styles and mixed-style text segments. Candidates are ranked by
intersection over union, and account for hidden layers and clipping frames.
Overlapping layers can yield multiple candidates. Traversal is bounded to
5000 nodes and reports truncation. This is a lookup aid, not reconstruction
of the Figma hierarchy into HTML. Existing `find-text`, `node-data`, and
`export` complement it. Figma lookup defaults to five candidates; increase
`limit` when needed. `node-data` defaults to CSS and fonts; pass
`fields:"text"`, `fields:"css,fonts"`, or `detail:"full"`. The plugin computes
only the requested fields. `extract-text` skips CSS/font computation.
Text/font scans are bounded to 50 text layers and 5000 visited nodes, with
explicit truncation markers. Target a smaller node or use `find-text` to narrow
the content when a scan is incomplete.

## Capture preparation and limits

Visual actions wait for load, fonts, and visible image decoding with bounded
waits, and return readiness information. They temporarily mask Min's design
overlay/controls, hide scrollbars, pause CSS animations, and hide the caret.
The previous styles are restored even on errors. `includeOverlay: true` can
be used for screenshots/inspection; comparison always masks the overlay.
`hideScrollbars: false` and `freezeAnimations: false` opt out of those changes.
JavaScript animation, video, and network updates can still affect captures;
retry when readiness is incomplete or dynamic content changes.
If the operating system stops producing frames for a minimized/occluded Min
window, capture times out with a recovery message. Restore Min/select the tab
and retry; no external browser is launched.

PNG/JPEG input is limited to 40 MB and 16 megapixels; captures also have a
16 megapixel limit. SVG exports remain downloadable files; use PNG exports
for comparison. Capture reports an error for page scale other than 1: reset
pinch zoom or fix mobile viewport metadata/horizontal overflow before comparing.
Mobile viewport emulation does not change the user-agent or add touch behavior.

## Verification

For assertions, semantic locators, and repeatable playbooks with reports, see
[Browser testing](BROWSER_TESTING.md).

```sh
npm run test:figma
npm run test:browser-visual
npm run buildMain
```

The visual suite creates a hidden native window with an offscreen-rendered
WebContentsView, isolated temporary profile, and local fixture using the app's
installed Electron. It exercises real
viewport/DPR capture, crop mapping, pixel differences, DOM/font inspection,
overlay restoration, debugger reuse, workspace restrictions, tool image
blocks, and playbook validation. On Linux a display server is required;
`npm run test:browser-visual -- --ozone-platform=x11` can use XWayland when
the compositor defers configuring never-shown Wayland windows.
