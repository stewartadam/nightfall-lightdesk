# Playwright product flows action

Run Chromium product flows in an existing Linux build-and-test job:

```yaml
- name: Run Chromium product flows
  uses: ./.github/actions/playwright-smoke
```

The caller must check out this repository, set up Node.js, pnpm and Rust, install Node
dependencies, generate TypeScript shared types, and download
the shared release WASM bridge. `ci.yml` supplies that artifact
and the backend executable produced by its native job.

The CI caller runs smoke tests even if a preceding hook fails, provided asset
preparation succeeded and the job has not been cancelled.

The action installs Chromium (without the headless shell) and its system
dependencies, which include ALSA, the headless backend's only native runtime
library. It then seeds
disposable showfiles in the runner's temporary directory and uploads reports even
when tests fail. With a `shard` input such as `2/6` it runs that shard of the full
suite (`pnpm run test:webui-playwright --shard=2/6 --max-failures=20`); without one
it runs only `pnpm run test:webui-smoke --max-failures=3`. The failure caps stop
repeated setup failures before they exhaust the job timeout. It uses two
workers by default; set the `workers` input to override this. `ci.yml` runs the
smoke specs with three workers on its four-vCPU runner, and the manually
triggered `playwright-full.yml` runs six shards of the full suite. Set a unique
`artifact-name` for each invocation in the same workflow run.

The wrapper builds the backend using the shared native Cargo graph unless
`NIGHTFALL_PLAYWRIGHT_BACKEND_EXECUTABLE` identifies an already-tested executable.
It copies either executable into the isolated run directory and restores execute
permissions, including after a GitHub artifact download. CI passes only the
backend artifact from the same workflow run and commit. Local invocations keep
the normal Cargo freshness check.

To test a production native frontend locally, build it first and set
`NIGHTFALL_PLAYWRIGHT_VITE_MODE=preview` and
`NIGHTFALL_PLAYWRIGHT_VITE_BASE=/` when invoking the repository wrapper. Browser
demo previews retain their `/demo/app/` base.
