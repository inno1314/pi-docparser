# Third-Party Notices

## LiteParse

This package depends on the following third-party library at runtime:

- **Package:** `@llamaindex/liteparse`
- **Version used by this package:** `2.10.1`
- **Repository:** https://github.com/run-llama/liteparse
- **License:** Apache-2.0
- **Local license copy:** [`./licenses/LiteParse-APACHE-2.0.txt`](./licenses/LiteParse-APACHE-2.0.txt)
- **Upstream license file:** https://github.com/run-llama/liteparse/blob/main/LICENSE

### Usage in this package

`pi-docparser` uses LiteParse v2 as an npm dependency to provide:

- local document parsing
- OCR support via LiteParse/Tesseract or optional HTTP OCR servers
- page screenshot generation
- phrase search with bounding boxes
- conversion support for Office and image inputs

LiteParse v2 is implemented primarily in Rust and uses platform-specific native npm packages. This package does **not** vendor LiteParse source code or native binaries directly; it relies on the installed npm dependency at runtime.

### Upstream attribution

LiteParse is developed by LlamaIndex and distributed under the Apache License 2.0.
Please review the upstream repository and license for full details.
