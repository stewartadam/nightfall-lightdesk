# Playwright product smoke action

Run the Chromium product smoke suite in an existing Linux build-and-test job:

```yaml
- name: Run Chromium product flows
  uses: ./.github/actions/playwright-smoke
```

The caller must check out this repository, set up Node.js and Rust, install npm
and native backend dependencies, generate TypeScript shared types, and download
the shared release WASM artifacts. `ci-precommit.yml` supplies those artifacts
and the backend executable produced by its native-check job.

The CI caller runs smoke tests even if a preceding hook fails, provided asset
preparation succeeded and the job has not been cancelled.

The action installs Playwright browsers and their system dependencies, seeds
disposable showfiles in the runner's temporary directory, runs
`npm run test:webui-smoke`, and uploads reports even when tests fail. It uses two
workers by default; set the `workers` input to override this. Set a unique
`artifact-name` when invoking the action more than once in the same job.

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
