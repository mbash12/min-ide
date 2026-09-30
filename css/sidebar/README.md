# Sidebar styles

`scripts/buildBrowserStyles.js` lists these modules in cascade order and emits
them as one group inside `dist/bundle.css`. The browser still loads one bundle;
there are no runtime CSS imports or additional stylesheet requests. The existing
recursive CSS watcher also covers this directory.

| File | Responsibility |
| --- | --- |
| `layout.css` | Sidebar shell, activity bar, resizing, panel visibility and prompts |
| `contentPanels.css` | Files tree, Docs/Notes lists and navbar toggle |
| `git.css` | Source Control panel base styles |
| `playbook.css` | Playbook panel and activity count badge |
| `gitSections.css` | Git repository, branches, graph and commit details |
| `agentMessages.css` | Agent header, history, transcript, Markdown and tool log |
| `agentComposer.css` | Composer, context usage, commands and picker shells |
| `components.css` | Shared panel primitives, theme variables and cross-panel styles |
| `gitLayout.css` | Git layout and interaction overrides applied after shared styles |
| `overlays.css` | Picker item states and shared sidebar/drawer/popover scrollbars |
| `design.css` | Figma status, output and export dialog |
| `designBuildQueue.css` | Design specs, build list, command queue and imports |
| `typography.css` | Final font sizing across all panels and detached popovers |

Keep the explicit build order: several rules intentionally override earlier
panel defaults. Add styles to the owning module instead of appending unrelated
features to a shared file. The split preserves every original rule and the
compiled bundle exactly, including whitespace.
