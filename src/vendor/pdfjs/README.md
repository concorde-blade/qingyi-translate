# PDF.js local distribution

Source: official npm registry package `pdfjs-dist@6.5.438`.

- Tarball: `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.5.438.tgz`
- Registry SHA-1: `e7f8986ec4ea04057b5d9d2f0e5b63ea94d2303f`
- License: Apache-2.0, included in `LICENSE`.
- `pdf.min.mjs` and `pdf.worker.min.mjs`: unmodified official `legacy/build/` files.
- `cmaps/` and `standard_fonts/`: unmodified support data, including their upstream license notices.

The application extracts text only. It uses an extension-local module Worker,
disables eval/WASM options and XFA, and loads support data from this directory.
PDF.js 6 no longer uses the older eval-based PDF function compiler; the explicit
`isEvalSupported: false` flag is retained as an additional compatibility guard.
The package's viewer, sandbox, renderer and WASM assets are not used or shipped.

No build/install scripts, optional native canvas package or CDN code are used.
