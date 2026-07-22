# Copilot `/share` asset drift oracle

`extract-share-assets.cjs` is a reverse-engineering aid, not part of
`recall`'s render path.

## What it extracts

The script reads the installed `@github/copilot` package's `app.js` bundle (or
an explicitly supplied bundle path), reconstructs the runtime strings stored
in its JavaScript template literals, and writes:

- `extracted-share-assets/share-export.css`
- `extracted-share-assets/share-export.js`

By default it searches the global npm installation and writes below this
directory. An explicit bundle and output directory can be supplied:

```bash
node tools/copilot/extract-share-assets.cjs \
  [path/to/@github/copilot/app.js] [out-dir]
```

Reconstructing the strings matters because copying the minified template
literal bodies byte-for-byte would preserve doubled escapes and produce broken
CSS/JavaScript.

## Why retain it

The extracted bundle is a **drift oracle**. Copilot CLI upgrades can change:

- timeline entry and filter classes;
- Primer light/dark theme rules;
- button ids and other JavaScript DOM hooks.

After upgrading Copilot CLI, re-run the extractor and diff its outputs against
the previous extraction. Treat meaningful changes as prompts to re-check the
offline event mapping and React renderer, not as assets to copy automatically
into production.

## Runtime and baseline status

The maintained HTML renderer is the React implementation in `packages/html`.
It does not import or ship `share-export.css` or `share-export.js`; generated
assets are not a runtime or build dependency.

Only `extract-share-assets.cjs` is tracked here. The extracted assets used by
the predecessor workflow lived with the old skill and are not present in this
repository. No size or hash baseline is currently available in the repository;
the extractor's printed lengths and a local checksum can be recorded when
performing a future comparison.
