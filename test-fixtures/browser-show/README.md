This canonical showfile JSON is shared by the browser runtime Rust tests and Playwright tests. It is a deterministic test fixture, independent of the externally supplied release demo bundle. Keep its IDs and domain state aligned with the assertions in those tests.

Audio bytes are generated in memory by `scripts/browser-demo-audio.mjs` and served by the frontend-only Playwright fixture. No binary media is required in this directory.
