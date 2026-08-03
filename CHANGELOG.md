# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows semantic versioning.

## [4.0.0] - 2026-08-03

### Breaking Changes

- raised the minimum Node.js version to `22.19.0`; Pi `0.83.0` is the development and test baseline, while Pi core peer ranges follow the `"*"` host-resolution policy
- changed the default `maxPages` from `1000` to `100`, retained `1000` as the hard maximum, and added strict page, worker, DPI, search, and output budgets
- changed screenshot requests to default to page 1, allow at most four explicit pages, reject `all`/`*`, and return only bounded inline images while preserving every accepted PNG by saved path
- stabilized JSON output as a bounded project-owned `{ pages, text }` projection instead of exposing additional upstream fields implicitly

### Fixes

- isolated each LiteParse native operation in a fresh child process behind one document-only FIFO so native crashes and worker out-of-memory failures do not terminate Pi
- added active and queued cancellation, an internal 10-minute operation timeout, process-tree teardown, and fail-closed behavior when teardown cannot be confirmed
- made parse and screenshot publication atomic and job-owned so failed or cancelled work does not publish partial artifacts or remove an earlier completed parse
- removed the obsolete ImageMagick preflight and installation requirement because supported image inputs are converted natively

### Dependencies

- upgraded `@llamaindex/liteparse` from `2.0.1` to exactly `2.10.1`
- updated `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` development dependencies to exactly `0.83.0`

### Tests

- added policy, executor, worker, output-projection, tool, dependency, metadata, native-fixture, packed-install, and process-cleanup coverage, including cross-platform process-tree behavior

## [3.0.0] - 2026-05-28

### Breaking Changes

- upgraded `@llamaindex/liteparse` from `1.5.3` to `2.0.1` and migrated to the LiteParse v2 Node API
- removed unsupported LiteParse v1 options from the public tool schema:
  - `preciseBoundingBox`
  - `preserveLayoutAlignmentAcrossPages`
- changed default `maxPages` from `10000` to LiteParse v2's default `1000`
- changed JSON parse output to the LiteParse v2 result shape: `{ pages, text }`

### Added

- added `document_search` for phrase search with page numbers and bounding boxes
- added `document_screenshot` for direct page rendering as PNG image content blocks plus saved temp files
- added optional `password` support for encrypted/password-protected documents
- added optional `tessdataPath` support for offline/custom Tesseract OCR data
- added helpful guidance when removed LiteParse v1 options are supplied

### Changed

- updated `document_parse` screenshot handling for the LiteParse v2 async screenshot API
- relaxed screenshot documentation away from PDF-only behavior; LiteParse v2 can screenshot supported converted formats when host tools are installed
- simplified host dependency checks to LibreOffice and ImageMagick in line with LiteParse v2 docs
- updated README, skill guidance, and third-party notices for LiteParse v2 and the new tools

## [2.0.0] - 2026-05-13

### Breaking Changes

- migrated Pi package integration from `@mariozechner/*` to `@earendil-works/*`; consumers must use the new scope
- raised minimum supported Node.js version from `>=18` to `>=20.6.0`

### Changed

- upgraded `@llamaindex/liteparse` from `1.0.0` to `1.5.3`
- updated extension imports and type usage to `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`
- tightened peer dependency ranges for Pi packages to `^0.74.0`
- switched repository package management to pnpm:
  - added `pnpm-lock.yaml`
  - removed `bun.lock`
  - removed `package-lock.json`

### Security

- added pnpm dependency hardening settings in `pnpm-workspace.yaml`:
  - `ignoreScripts: true`
  - `minimumReleaseAge: 4320` (3 days)
  - `minimumReleaseAgeStrict: true`
  - `blockExoticSubdeps: true`

### Documentation

- updated README runtime requirement to Node.js `20.6+`

## [1.1.1] - 2026-03-20

### Fixed

- added explicit `extension` and `skill` npm keywords so the Pi package gallery can show the correct package type badges for `pi-docparser`

## [1.1.0] - 2026-03-20

### Changed

- renamed the dependency diagnostic command from `/docparser-doctor` to `/docparser:doctor`
- improved `/docparser:doctor` so missing dependencies are reported as normal diagnostics instead of error-style command failures
- added a dedicated in-progress loader while automatic dependency installation commands are running
- unified doctor install guidance and auto-install command generation, including correct Homebrew cask usage for LibreOffice on macOS

## [1.0.1] - 2026-03-20

### Changed

- added Pi package gallery preview image metadata
- added concrete `document_parse` usage examples to the README
- added GitHub repository metadata to improve the npm package listing

## [1.0.0] - 2026-03-20

Initial public release.

### Added

- `document_parse` pi extension powered by LiteParse for PDFs, Office documents, spreadsheets, CSV files, and common images
- OCR support, text or JSON output, page targeting, and optional PDF screenshot extraction
- `/docparser-doctor` command for host dependency checks and guided setup hints
- `parse-document` skill, package docs, third-party notices, and preview assets
- Bun-based validation scripts for formatting with `oxfmt`, linting with `oxlint`, and TypeScript type checks
