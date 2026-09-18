# Playwright product smoke action

Run the Chromium product smoke suite in an existing Linux build-and-test job:

```yaml
- name: Run Chromium product flows
  uses: ./.github/actions/playwright-smoke
```

The caller must check out this repository, set up Node.js and Rust, install npm
and native backend dependencies, download the beat detection model, generate
TypeScript shared types, and build the development WASM assets. The
`ci-precommit.yml` workflow provides this setup once for its checks and smoke
tests. Keep the action in that same job to reuse its Cargo target directory and
generated assets.

The CI caller runs smoke tests even if a preceding hook fails, provided asset
preparation succeeded and the job has not been cancelled.

The action installs Playwright browsers and their system dependencies, seeds
disposable showfiles in the runner's temporary directory, runs
`npm run test:webui-smoke`, and uploads reports even when tests fail. It uses two
workers by default; set the `workers` input to override this. Set a unique
`artifact-name` when invoking the action more than once in the same job.

The repository Playwright wrapper still builds the backend with
`--no-default-features --features full,beatgrid-detect` before staging it for
isolated workers. Cargo reuses compatible artifacts from earlier steps; crates
whose feature sets differ from the default-feature Rust checks can still require
compilation. No binary freshness checks or Rust feature coverage are skipped.
