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
  original project. Same file, same 30 tests, all passing here.
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
  (`src/schemaService.ts`), backed by 14 new unit tests covering the
  same cases the original Apex logic was verified against (including
  the additive `cascadeDelete` signal for Master-Detail detection, and
  the `calculated`-must-gate-first fix for Roll-Up Summary — a real bug
  this port's own tests caught before it shipped, not a hypothetical).
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

## What's not built yet

- **Data Dictionary, Sharing View, Heatmap** — all need Tooling API or
  aggregate SOQL queries via `sf data query`. Not started.
- **Drag-and-drop from a visual palette** — the object list now feeds a
  text-based autocomplete (above), but there's no separate visual
  palette panel to drag entities from directly onto the canvas yet.
- **DSL autocomplete, the object summary hover card, the smart
  relationship linter, schema drift comparison** — none of these exist
  yet.
- **Multi-file tabs** — each `Salesforce ER Modeller: Open` opens a
  single panel; there's no tab strip for working on several diagrams at
  once yet.
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
