# Third-party notices

Tavern depends on separately licensed software. This guide is not a replacement
license or an exhaustive attribution inventory.

- **Element Call embedded 0.25.0** includes AGPL-3.0 and commercial license
  notices from Element. `scripts/prepare-call-assets.mjs` preserves both notices
  and writes a corresponding-source reference into the served `/element-call/`
  directory. It externalizes two bootstrap scripts and supplies local
  configuration; that transformation is included in this repository.
- **Matrix JavaScript SDK, Matrix Rust crypto, matrix-widget-api, matrix-nio,
  React, Vite, and other packages** retain their licenses in installed
  distributions. Exact resolutions are in `package-lock.json` and
  `integrations/requirements.lock`.
- **Vendored shadcn Tailwind CSS** has its license at
  `vendor/shadcn-tailwind-4.13.0.LICENSE.md`.
- **Synapse, PostgreSQL, nginx, coturn, LiveKit, and the MatrixRTC authorization
  service** are separate distributions with upstream licensing and source
  obligations. Their presence in Compose does not change their licenses.

No project-wide license has been selected for Tavern in this repository.
Publishing this branch does not apply a new license to the owner's code or
override upstream terms. Preserve notices and corresponding-source material
when redistributing or operating bundled components.
