# Salesforce ER Modeller (VS Code extension)

A VS Code port of [Salesforce ER Modeller Studio](https://github.com/vikascohen/SalesforceERModellerStudio),
the native Lightning Web Component app for the same purpose. That project
remains the org-native / managed-package version; this is a separate,
standalone extension for working with Salesforce data models directly in
VS Code, with no dependency on it or on the target org having anything
installed.

**Status: early scaffold, not yet feature-complete.** This is being built
incrementally, the same way the original LWC app was — a working core
first, verified at each step, before layering in the rest of the feature
set. Below is an honest account of what's real right now versus what's
still a placeholder or not yet started.

## What works right now

- The DSL parser, geometry engine, and Mermaid/draw.io export logic
  (`src/erDiagramLogic.js`) is a direct, unmodified port from the
  original project — same file, same tests, all 30 passing here. It has
  zero VS Code or Salesforce dependencies of its own, which is what
  makes it portable at all.
- The extension activates, registers a command
  (`Salesforce ER Modeller: Open`), and opens a webview panel.
- Typing DSL text in the editor pane renders live SVG boxes and
  connectors on a canvas, using the ported parser and geometry engine —
  this is a real, working render loop, not a mock.

## What's stubbed or not yet built

- **Import from Org** — the button exists and posts a message to the
  extension host, but nothing on the extension-host side listens for it
  yet. No Salesforce CLI integration exists at all yet.
- **Visual styling** — the canvas currently draws plain, unstyled boxes
  using VS Code's theme colors. None of the original app's PK/FK
  markers, relationship arrow styles, Roll-Up Summary badges, or themes
  are ported yet.
- **Persistence** — nothing is saved anywhere yet. The eventual plan is
  local DSL files in the workspace rather than Salesforce records, since
  that fits a dev-tool distributed via VS Code rather than one running
  inside an org, but this hasn't been built.
- Sharing View, Heatmap, Data Dictionary, hover card, Master-Detail/
  Roll-Up Summary detection, drag-and-drop from a palette, multi-file
  tabs — none of this exists yet. All of it needs a working Salesforce
  connection first (see Import from Org above), which is the next real
  piece of work.

## Development

```bash
npm install
npm run compile   # or: npm run watch
npm test          # Jest — currently just erDiagramLogic.test.js
```

To actually run the extension inside VS Code (not yet verified from this
environment — see note below): open this folder in VS Code, press F5 to
launch an Extension Development Host, then run
`Salesforce ER Modeller: Open` from the command palette.

**A genuine limitation worth stating plainly:** everything above marked
as working has been verified by compiling cleanly (`tsc`) and by running
the Jest suite. None of it has been interactively launched inside actual
VS Code yet — that needs a real desktop VS Code session, which the
environment this was built in doesn't have. Treat the webview/extension
wiring as "should work, compiles cleanly, not yet visually confirmed"
until someone actually presses F5 and reports back.

## License

MIT
