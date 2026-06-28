# Legacy dredge-up vanilla snapshot

This directory temporarily snapshots the old Python-only Copilot `/share html`
reconstruction path from the `dredge-up` skill before removing it from the
new `session-recall` codebase.

The extracted `share-export.css/js` files are intentionally not committed here.
They are generated from the installed `@github/copilot` bundle and should be
re-extracted only for local reference with `tools/copilot/extract-share-assets.cjs`.
