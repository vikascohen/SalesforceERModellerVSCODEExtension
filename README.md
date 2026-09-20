# Salesforce ER Modeller (VS Code extension)

A VS Code port of [Salesforce ER Modeller Studio](https://github.com/vikascohen/SalesforceERModellerStudio),
the native Lightning Web Component app for the same purpose. That project
remains the org-native / managed-package version; this is a separate,
standalone extension for working with Salesforce data models directly in
VS Code, with no dependency on it or on the target org having anything
installed.

**Status: a real, working core, not yet the full feature set.** Built
incrementally, verified at each step, the same way the original LWC app
was. Below is an honest account of what's genuinely working versus
what's still missing — not everything from the original app is here yet.

## Requirements

- The [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli)
  (`sf`), installed and with at least one org authenticated
  (`sf org login web`). This extension does not manage authentication
  itself — it shells out to whatever `sf` command you'd run yourself in
  a terminal, the same way the existing Salesforce Org Visualizer
  extension already does, rather than introducing a second auth
  mechanism.

## What works right now, genuinely verified

- **The DSL parser, geometry engine, and Mermaid/draw.io export logic**
  (`src/erDiagramLogic.js`) is a direct, unmodified port from the
  original project, re-synced most recently to pick up the `[Required]`
  field marker feature and the bracket-aware field-list splitting fix.
  Same file, same 35 tests, all passing here.
- **Org connection**: a status bar item shows the current default org
  (or prompts to select one); `Salesforce ER Modeller: Select Org` lists
  every authenticated org via `sf org list` and switches the CLI's
  target org.
- **Import from Org**: type object API names, click Import, and the
  extension calls `sf sobject describe --json` for each one, classifies
  every field (Master-Detail vs. Lookup vs. Polymorphic Lookup, Roll-Up
  Summary vs. genuine Formula, required, friendly type label), and
  appends the resulting DSL to the editor — a direct TypeScript port of
  `SchemaMetadataController.cls`'s classification logic
  (`src/schemaService.ts`), backed by 16 unit tests covering the same
  cases the original Apex logic was verified against (including the
  additive `cascadeDelete` signal for Master-Detail detection, the
  `calculated`-must-gate-first fix for Roll-Up Summary, and — found and
  fixed here directly, mirroring a real bug already caught once in the
  Apex version — Checkbox fields and true system fields like
  `CreatedDate` no longer show as `required` just because they are
  non-nillable by platform design; `required` now also needs
  `createable` and a non-Checkbox type).
- **Full canvas styling**: primary keys marked with a gold `*`,
  relationship fields with a purple `~`, Roll-Up Summary fields with a
  teal `Σ` — the same visual language as the original app, not a new
  one. Relationship lines use the same stroke colors, dash patterns, and
  arrow/diamond markers as the original (solid purple diamond for
  Master-Detail, dashed red open diamond for Polymorphic, solid blue
  arrow for Lookup), including cardinality labels at each end. Custom
  vs. standard object header coloring comes directly from the ported
  geometry engine's own `headerFill` output.
- **Focus mode**: click an entity (with the toggle on) to dim everything
  not directly related to it.
- **Save / Save As / Open**: diagrams persist as local `.erd` files via
  standard VS Code save/open dialogs, not Salesforce records — the
  natural fit for a dev tool, version-controllable in Git. Ctrl/Cmd+S
  saves; the panel title shows a dirty-state dot.
- **Export**: Copy Mermaid syntax to the clipboard, or export a
  `.drawio` file — both reuse the same ported, tested export functions
  the original app uses.

- **Object autocomplete for Import from Org**: typing in the import
  field fetches the org's full object list (`sf sobject list --sobject
  all --json`) and filters it live, matching anywhere in the name, not
  just the start — click a suggestion to add it to the list. The
  filtering logic itself is pure and unit tested (10 tests) separately
  from the DOM wiring, since the DOM interaction isn't something this
  environment can verify without real VS Code, but the matching logic
  underneath it is.
- **DSL editor autocomplete**: typing directly in the DSL editor itself
  (not just the Import panel) now offers live suggestions for the
  `entity` keyword, object names, field names (with the same
  `[Type, Required]` marker Import from Org would generate), a
  relationship field's own name, the relationship arrow (`=>`/`->`/`~>`),
  and the target entity on the other side of an arrow — six distinct
  contexts total, ported directly from the original app's own
  `detectDslContext`, including its two known, already-fixed bugs
  preserved intact rather than re-derived from scratch: bracket-aware
  field-list splitting (a field with its own `[Type]` suffix earlier on
  the line no longer breaks detection for anything typed after it), and
  cursor-position-aware exclusion (a field already on the line, even one
  sitting after wherever the cursor currently is, is correctly excluded
  from suggesting itself again). The context-detection logic itself is
  pure and unit tested (14 tests, one per context plus both bug-fix
  scenarios explicitly) exactly like the object-autocomplete filtering
  above; the DOM wiring and on-screen dropdown positioning follow the
  same real, stated limitation below.
- **Data Dictionary**: a new button opens a full-screen panel — a
  searchable object list on the left, and on the right, the selected
  object's fields with label, type, required, description and
  last-modified date (from `FieldDefinition` via the Tooling API, the
  same source the original Apex version reads), and an on-demand
  "Calculate Usage" button. Usage is never computed automatically,
  since it scans actual record data: a direct port of the original's
  batched-aggregate-query approach (`COUNT(field1), COUNT(field2), ...`
  in groups of 15, not one query per field), so a handful of fields
  share one query rather than needing dozens of round trips, with a
  failing batch falling back to "not available" for just its own fields
  rather than the whole object. Exports to a real `.xlsx` file via
  `exceljs`, generated on the extension host side (not the webview,
  which can't run a Node.js-oriented library like this directly) and
  saved through the standard VS Code save dialog. Stated plainly since
  it's a real gap, not a silent one: the batched-query logic itself has
  no automated test of its own, unlike everything else in this port — it
  shells out via the `sf` CLI, and testing it properly would need
  mocking `child_process`, which nothing else in this codebase currently
  does; it's a faithful, line-by-line port of already-proven Apex logic,
  which is why this was accepted as a stated gap rather than blocking on
  building that mocking infrastructure.
- **Sharing View / Heatmap toggles**: two checkboxes in the toolbar,
  direct ports of `getSharingModels()` and `getRecordCounts()` from
  `SchemaMetadataController.cls`. Sharing View badges each box with its
  org-wide default (internal / external), sourced from
  `EntityDefinition` via the Tooling API. Heatmap colors each box by
  activity, the same three states as the original app, not just a
  binary "has records or not": empty (orange), stale (amber, records
  exist but none touched in over a year), active (blue, touched within
  the last year) — computed from one aggregate query per object
  (`COUNT(Id)` and `MAX(LastModifiedDate)` together). Data refreshes
  automatically as entities are added to the DSL while a toggle is
  already on.
- **Object summary hover card**: hover any entity on the canvas (no
  toggle needed) for field count, standard/custom status, plus whatever
  the two toggles above have already fetched — record count with the
  same stale/active wording Heatmap's color encodes, internal/external
  sharing, and Sharing Rules / Apex Sharing (direct port of
  `getSharingSignals()` — reliable Yes/No for Sharing Rules on any
  object; Apex Sharing is a real Yes/No only on custom objects and
  correctly says "Not determinable on standard objects" otherwise,
  matching the original's own stated reasoning: a standard object can't
  define its own Apex Sharing Reason, so Apex Managed Sharing and plain
  manual sharing there produce the exact same underlying signal and
  can't be told apart).
- **Smart relationship linter**: 600ms after any edit, scans every
  entity on the canvas for relationship fields pointing at another
  entity also on the canvas that isn't yet wired up as a DSL
  relationship line, and shows them in a panel with per-item Add, Add
  All, and Dismiss (dismissed suggestions stay dismissed for the rest of
  the session). The scan itself is a pure, unit-tested function (6
  tests) ported directly from the LWC's own
  `scanForMissingRelationships` — separate from the DOM wiring around
  it, matching the same testing split used for DSL autocomplete and
  object-name filtering elsewhere in this port.
- **Compare with Org / schema drift**: re-describes every entity
  currently on canvas right now and compares it against what the DSL
  actually says, showing fields that exist in the org but not the
  diagram (Add / Add All) and fields in the diagram no longer in the org
  (shown, not auto-removed — matching the original: a field that
  disappeared from the org isn't necessarily something you want silently
  dropped from your own notes about it). An entity that isn't a real or
  accessible org object is skipped quietly rather than treated as "every
  field is missing". The comparison itself is a pure, unit-tested
  function (5 tests) ported directly from the LWC's own
  `checkSchemaDrift`, including the exact fix already made once there:
  a field's marker suffix (`[Type, Required]`) is computed while the
  full field object is still in scope, so a field added this way lands
  identical to one added via Import from Org or autocomplete, not a
  bare, unmarked name.
- **Multi-file tabs**: both `Salesforce ER Modeller: New Diagram` and
  `Salesforce ER Modeller: Open` now create a genuinely separate panel
  each time, rather than the earlier singleton behavior where `Open`
  silently replaced whatever diagram (and its unsaved edits) was already
  showing in the one existing panel. VS Code's own editor tab strip
  provides the actual multi-tab UI for free once each panel is genuinely
  separate — no custom tab UI needed on top of it, unlike the original
  LWC app, which had to build its own. Fixed a real bug found while
  wiring this up, not just flipped a flag: the panel's own disposal
  logic unconditionally cleared the extension's single tracked
  "current panel" reference on close, so closing an OLDER tab while a
  NEWER one was still open incorrectly lost track of that still-open
  newer panel too — fixed by only clearing that reference when the
  closing panel is actually the one being tracked, and separately
  tracking every open panel in its own list for anything (like an org
  switch) that needs to reach all of them, not just the most recent one.
- **Object palette (drag-and-drop)**: a new toggleable sidebar lists
  every object, searchable, and dragging one onto the canvas adds it —
  reuses the exact same `importFromOrg` message Import from Org already
  sends, rather than a separate code path, since describing one dropped
  object and describing a typed-in list of objects need identical
  handling. One deliberate simplification from the original, not a
  missing feature: the LWC also tracks a manual x/y drop position per
  entity, overriding the geometry engine's automatic layout for that one
  entity specifically — this port has no manual position tracking
  anywhere else either (nothing here overrides the auto layout, ever),
  so a drop just adds the entity and lets the geometry engine place it,
  consistent with how every other entity on this canvas is positioned.

## What's not built yet

- **Themes** — the canvas currently just uses VS Code's own theme colors
  automatically (a side effect of using `var(--vscode-*)` throughout,
  not a deliberate theming feature); none of the original's four named
  themes are implemented as a choice.

## A genuine limitation of this whole port, stated plainly

Everything above has been verified by compiling cleanly (`tsc`),
running the Jest suite, and reviewing the code directly — **nothing has
been interactively launched inside real VS Code**, since the environment
this was built in has no VS Code binary at all. The `sf` CLI shape
assumptions in `sfCli.ts` and `schemaService.ts` are based on
Salesforce's long-stable, publicly documented REST Describe API (which
`sf sobject describe` wraps directly) — not guessed at, but also not run
against a live, authenticated org from here, since none is available in
this environment either. Treat "compiles and passes its tests" as
exactly that, not as "confirmed working end to end" until someone
actually presses F5, connects a real org, and reports back what
happens.

## Development

```bash
npm install
npm run compile   # or: npm run watch
npm test          # Jest — erDiagramLogic (30) + schemaService (14) + paletteFilter (10)
```

To run the extension inside VS Code for development/testing: open this
folder in VS Code, press F5 to launch an Extension Development Host, run
`sf org login web` in its terminal if you haven't already, then run
`Salesforce ER Modeller: Open` from the command palette. Each F5 press
opens a temporary, separate VS Code window running the extension — it
doesn't install anything permanently and disappears when you close that
window.

## Installing it as a real extension

F5 is for development. To have it show up as an ordinary, permanently
installed extension in your actual VS Code — like anything from the
Marketplace — package it into a `.vsix` file and install that:

```bash
npm install -g @vscode/vsce   # one-time, packages extensions into .vsix files
npm install
npm run compile
vsce package                  # produces sf-er-modeller-0.1.0.vsix in this folder
```

Then either run `code --install-extension sf-er-modeller-0.1.0.vsix`,
or in VS Code itself open the Extensions view, click the `...` menu in
its top corner, and choose "Install from VSIX...". It'll then appear in
your Extensions list like any other installed extension, persist across
restarts, and its commands show up in the command palette without
needing to press F5 first.

This isn't published to the VS Code Marketplace — installing the
`.vsix` directly is the only distribution method right now.

## License

MIT
