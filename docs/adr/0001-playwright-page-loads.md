# 1. Playwright page loads: shared dev server, test hooks, then preview builds

- Status: Accepted
- Date: 2026-10-06

## Context

Native Playwright specs spend most of their time starting the app, not interacting with it. A trace of `showfile-menu.spec.ts` "shows grouped showfile actions in the status bar menu", run with one worker in a 4-core cloud container, showed:

| Phase | Cold worker | Warm worker |
| --- | ---: | ---: |
| Page load | 7.0 s | 1.8 s |
| Waiting for the interactive shell | 5.6 s | 4–6 s |

- **Page load.** Each Playwright worker runs its own Vite dev server, so the first page load in every worker compiles the app on demand. A page load issues about 826 requests, 765 of them individual source modules, and `index.css` alone takes about 5 s while Tailwind compiles it. Under CPU contention (three workers on four cores), a cold load reached 12 s. A developer's long-running dev server is always warm, which is why the same page loads in 1–2 s there.
- **Shell readiness.** The 4–6 s remain on a warm server. They cover connecting to a freshly seeded backend, the resync, mounting the default layout and rendering the 3D visualizer on the CPU in headless Chromium. Specs detect readiness by polling app internals.
- **Production builds.** A `vite build` of the web UI takes about 11 s and would replace the module waterfall with a few bundles. Native specs cannot use one today:
  - Outside dev, `webui/lib/api.ts` always connects to backend port 3030, but every test backend has its own port.
  - `window.appStores` is only exposed in dev and in browser-demo e2e sessions.
  - 46 spec files make 143 `import("/…")` calls that only the dev server can serve. About 100 reach into app modules: `lib/engine-runtime.ts` (37), layout storage and management, lifecycle, readiness, settings, performance, keyboard shortcuts, the wasm bridge and the renderer. The remaining 43 load browser-side harnesses from `webui/e2e/fixtures/` (three.js, optics and timeline playback).

Tauri builds must keep using port 3030, and `pnpm run tauri dev` must keep ignoring `.env`.

## Decision

Move in three steps. Each step stands on its own.

1. **One shared dev server per run.** The Playwright pool starts and warms a single Vite dev server, shared by every worker. A Playwright fixture gives each browser context a cookie naming its test's backend port, and the server's `/api` and `/ws` proxies route each request by that cookie. The app runs with `NIGHTFALL_VITE_PROXY=1`, so its WebSocket also goes through the proxy and every backend call stays same-origin. Requests without the cookie go to an unused port and fail loudly instead of reaching another test's backend. The app's backend URL logic does not change, so Tauri and built bundles are unaffected. This removes the per-worker cold compile without spec changes.

   An earlier attempt injected the port into the page and connected to the backend directly. That made HTTP cross-origin: `page.route` mocks then need CORS headers, and eight timeline specs regressed. Routing in the proxy avoids both.
2. **A test hooks API.** When `e2e=1` is set, the app exposes `window.__nightfallTest`. It offers lifecycle events or promises (interactive shell, resync complete, layout applied, showfile loaded) and a small set of handles (command send, stores, renderer). Specs migrate incrementally from source-module imports and readiness polling to these hooks. The browser-side harnesses move into an e2e entry that a build can bundle.
3. **Preview builds for native specs.** Once no spec imports source modules, native runs build once per run and serve the bundle with `vite preview`. With `e2e=1`, the built web UI then sends backend traffic to its own origin, and the preview server's proxy routes it by the same cookie. Tauri keeps its injected desktop port. Embedded-demo specs keep their existing browser-demo preview mode.

## Consequences

- Step 1 removes cold compiles from every worker after the first and needs no spec changes. Warm page loads (about 1.8 s) and shell readiness (4–6 s) remain.
- Step 2 gives specs a supported contract instead of reaching into module internals. Readiness waits become event-driven rather than polled. The hooks become part of the app's maintained surface, gated behind `e2e=1`.
- Step 3 makes tests exercise the bundle that ships and removes the remaining module waterfall. Local runs pay about 11 s per run for the build and need a rebuild to pick up source edits. An opt-out to dev mode keeps quick edit-and-rerun loops.
- Backend URL resolution in `api.ts` is also changing for LAN access (PR #179, page-host backend URL). Step 1 leaves `api.ts` alone, and step 3 must keep same-origin routing for `e2e=1` builds compatible with that rule.
- Proxying the WebSocket adds one local hop compared with connecting to the backend directly.
- Dropping the 3D visualizer from the e2e default layout, unless a spec asks for it, is a separate lever on shell readiness and interaction time. In one experiment it cut a test from 49 s to 35 s.
