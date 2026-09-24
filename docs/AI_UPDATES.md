# Models and connection updates

Pro Settings → AI Provider has **Refresh models**, **Check connection updates**,
and **Update connection components**. The provider list stays unchanged.

Refresh models forces discovery for the existing providers after their
credentials and OMP adapters are installed. Normal model-picker requests
revalidate a 15-minute cache. A provider failure retains its previous models
and is reported in Settings; other providers still refresh. Providers without
live discovery use the catalog shipped with their component version.

Connection updates download the latest OMP packages from the npm registry,
build the existing adapters in a temporary directory, and check the module
exports and catalog before activation. Node.js with npm must be available.
Downloads disable package install scripts. Min ships its builder and
compatibility sources, so routine model and transport updates need no Min
source edit or app rebuild.

Versions live under `<Min userData>/pi-agent/omp-updates/versions`; an atomic
`active.json` selects the active bundle. Download, build, and compatibility
failures leave the previous selection intact. A newer bundled version takes
precedence over an older installed update. Replies already in progress keep
their runtime; subsequent turns load the updated adapters and preserve chat
history. An upstream change outside the adapter contract can still require a
Min update; an incompatible module is rejected before activation.

Run `npm run test:ai-updates` for catalog, isolation, OAuth, and update rollback
tests. `npm run build` generates the bundled adapters, builder, and version
manifest included in the app package. A local isolated registry test on
2026-09-24 installed, built, validated, and activated OMP 18.3.0 using Min's
Electron runtime.

# Tool names and skills

The custom tool IDs and their Min labels are `browser` (Browser), `playbook`
(Playbook), `docs` (Docs), and `design` (Design). Design's `spec-list` action
reads the **Build list** directly from the workspace store, including when
Figma is disconnected. Existing history named `figma` displays as Design.

The agent and Pro Settings → Tools use the same catalog. Skills come only
from `<Min userData>/pi-agent/skills` and `<workspace>/.pi/skills`. Skills owned
by other applications in `~/.agents/skills` or ancestor directories, including
Orca skills, are not automatically imported into Min.
