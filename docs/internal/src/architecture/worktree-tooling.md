# Worktree tooling

{{#include ../includes/human-review-disclaimer.md}}

The worktree tooling has two halves. Worktrunk (`wt`) hooks prepare a worktree when it's created and clean up when it's removed. The worktree dashboard is one Node.js process that owns the running services of every worktree, and three clients drive it over HTTP: a web page, the `wt service` terminal alias, and an MCP server for agents. This page explains how the pieces fit, how the dashboard tracks services, and the HTTP API they share. For day-to-day use, see [working in worktrees](../contributing/worktrees.md).

None of this ships with Nightfall. It lives in `worktree-dashboard/`, `scripts/`, `.config/wt.toml`, and `webui/worktree-dashboard.tsx`, and only contributors run it.

## The pieces

The following diagram shows who talks to whom:

```mermaid
flowchart LR
  accTitle: Worktree tooling components
  accDescr: Worktrunk runs the project hooks from wt.toml. Claude Code hooks call Worktrunk. The dashboard page reaches the dashboard API through the Vite proxy. The wt service alias and the MCP server reach the API through the shared dashboard client. The pre-remove hook calls wt service. The API spawns each worktree's services and reads every worktree's .env file.
  claude([Claude Code hooks]) --> wt[wt]
  wt -- runs --> hooks[Project hooks<br/>.config/wt.toml]
  hooks -- pre-remove --> alias
  page[Dashboard page] -- /worktree-api --> vite[Vite proxy]
  vite -- /api --> api[[Dashboard API]]
  alias[wt service alias] --> client[Dashboard client]
  mcp[MCP server] --> client
  client -- /api --> api
  api -- spawns --> services[(Services of<br/>each worktree)]
  api -- reads --> env[(.env of<br/>each worktree)]
```

Only the dashboard API starts or stops services. The clients hold no service state. They ask the API for a snapshot and send it actions, so a service started from the terminal shows up on the page and an agent can stop it.

The `.env` file in each worktree is the contract between the two halves. The `wt` hooks write it, and the dashboard reads it on every request to learn the worktree's ports and settings.

## Worktree hooks

`.config/wt.toml` declares the project hooks. Worktrunk runs the commands in one `[[pre-start]]` or `[[post-start]]` table in parallel, and runs the tables in order:

| Stage | Hooks | Purpose |
|---|---|---|
| pre-start | `setup-env` | Picks the port block and writes `.env`. Runs alone, because the steps after it read the port. |
| pre-start | `install`, `typeshare` | Installs packages and generates TypeScript types, so the editor works at once. |
| post-start | `copy-data-dir`, `copy-assets`, `copy-demo-audio` | Seeds the data directory and copies untracked assets from the main worktree. |
| post-start | `build`, `wasm-build` | Builds the backend, test binaries, and WASM bridge in the background. |
| pre-remove | `stop-services` | Runs `wt service stop -s all --best-effort`. |

Pre-start hooks block until they finish. Post-start hooks run in the background after `wt` hands you the worktree, which is why a service can start before its build is done.

The `setup-env` hook runs two scripts. `scripts/allocate-worktree-port.mjs` reads every other worktree's `NIGHTFALL_PORT` and prints a block of 10 ports between 3000 and 3999, aligned to a multiple of 10, that overlaps none of them. It treats each taken port as the start of a full block, so an unaligned port such as the primary checkout's is also safe. A worktree that already has a port keeps it while nothing overlaps it, so rerunning the hook doesn't move its URLs. The hook passes the result to `scripts/setup-env.mjs --port`, which knows nothing about other worktrees: it copies the main worktree's `.env` and overrides a few keys. Secondary worktrees also get a private `NIGHTFALL_DATA_DIR` and have network input and output turned off.

`setup-env.mjs` ignores an inherited `NIGHTFALL_PORT` environment variable. A process that loaded another checkout's `.env` into its environment would otherwise hand that checkout's port to the new worktree. For the same reason the dashboard never loads its own `.env` into its environment.

The `[aliases]` table adds `wt done`, which removes landed branches through `scripts/worktree-done.mjs`, and `wt service`, which runs `worktree-dashboard/worktree-service.mjs` with the worktree path. Worktrunk reads aliases and hooks from the `wt.toml` of the worktree you run it in, so a change to them reaches a worktree only once its branch includes the change.

Claude Code doesn't read `wt.toml`. Its `WorktreeCreate` and `WorktreeRemove` hooks in `.claude/settings.json` run `scripts/claude-worktree-hook.mjs`, which calls `wt switch --create` and `wt remove`, so the same project hooks run for agent worktrees. The hook and the dashboard's create endpoint share `worktree-dashboard/worktree-create.mjs`, which checks out a branch that exists locally or on `origin` and creates any other name from `origin/HEAD`.

## How the dashboard tracks a service

The dashboard knows a service in two ways:

- Managed: the dashboard spawned the process and holds its child handle, process ID, log path, exit code, and last error. It keeps this record in memory only.
- Observed: something answers on the service's port. On every snapshot the dashboard probes the backend, web UI, and both book ports on `127.0.0.1` and `::1`, and looks up the listening process ID. The lookup runs `lsof` or `ss`, so its result is cached per port until that process exits or the port closes.

The status phrase combines the two:

| Managed process running | Port answers | Status |
|---|---|---|
| Yes | Yes | managed + reachable |
| Yes | No | managed starting/unreachable |
| No | Yes | external process detected |
| No | No | stopped |

The `wasm` service has no port. It's a one-off build, so its status is `completed` or `failed` from its exit code. The sender examples have no port either, so the dashboard reports them as observed while their managed process runs.

Because the managed record lives in memory, restarting the dashboard forgets every process it started. On shutdown it stops them, so they don't outlive it as orphans. Services you start by hand appear as external processes.

### Pushing changes

`worktree-dashboard/state-stream.mjs` sends snapshots to the page over `GET /api/events`, and only when one differs from the last one sent. Snapshots are rebuilt when:

- an API action finishes, or a managed process exits;
- Git's metadata shows a worktree added or removed, or a branch switch (a watch on `HEAD` files under Git's common directory). The cached `git worktree list` is dropped then; if the watch can't start, the list isn't cached at all;
- a timer fires. It runs only while a page is connected: every second while a managed service is starting and for 15 seconds after any change, and every 10 seconds otherwise, to catch services started or stopped outside the dashboard.

Port probes are plain TCP connections, so a quiet timer check spawns no processes.

## Service lifecycle

Each service is an entry in `SERVICE_DEFINITIONS`: a command, its arguments, and whether it runs through Cargo. Arguments can be a function of the worktree's environment, which is how the book services pass `--port`. A service whose port comes from `SERVICE_PORT_OFFSETS` gets `NIGHTFALL_PORT` plus its offset.

The three actions work like this:

- Start: skips a service the dashboard already runs, and leaves an external process on the service's port running and reports it as unmanaged. Otherwise it reads the worktree's `.env`, layers it over the environment the dashboard started with, and spawns the command in the worktree with output going to a new log file.
- Stop: sends `SIGTERM`, then `SIGKILL` after 3 seconds, and waits up to 5 seconds for exit. If the port still answers, it terminates whatever listens there, so stop also clears external processes.
- Recycle: stops, clears the port, and starts again.

Backends started by the dashboard default to `NIGHTFALL_STARTUP_CMDS=fps 5` to keep idle CPU use low, unless the worktree sets the value itself. The backend of the checkout running the dashboard gets no startup commands, and uses the default data directory unless its `.env` sets one.

The API answers an action as soon as it spawns the process. The client then polls snapshots every 500 milliseconds until each service is online or failed, and reads the tail of each failed service's log. This keeps the API stateless between requests, and each client chooses how long to wait. The `wt service` alias waits up to 600 seconds and the MCP server 90 seconds by default.

## Dashboard API

The API listens on `127.0.0.1:4780` by default. `NIGHTFALL_WORKTREE_DASHBOARD_HOST` and `NIGHTFALL_WORKTREE_DASHBOARD_PORT` change it, for both the API and its clients. A worktree's ID is its absolute path, encoded as base64url. Every route that takes an ID returns 404 when `git worktree list` no longer lists that path.

Because the API creates and deletes worktrees and starts and kills local processes, `worktree-dashboard/request-guard.mjs` checks every request before it is routed, so a web page open in the same browser cannot drive it. It answers 403 when the `Host` header doesn't name this machine (a loopback name or the listen address), which stops DNS rebinding, or when the `Origin` header isn't a loopback origin. Browsers send `Origin` on cross-origin POSTs even when the page can't read the response, so this is what stops a page from creating or deleting worktrees. Clients that send no `Origin`, such as the MCP server and the `wt service` alias, pass on the `Host` check alone. The web UI reaches the API through the Vite dev server's `/worktree-api` proxy, which forwards the page's origin. To open the dashboard through a dev server on another address, such as from another device on your LAN, list that origin in `NIGHTFALL_WORKTREE_DASHBOARD_ALLOWED_ORIGINS` (comma-separated, for example `http://192.168.1.20:3031`). The hostnames of listed origins are accepted as `Host` too.

| Method and path | Query | Description |
|---|---|---|
| `GET /health` | None | Returns `{"ok": true}`. |
| `GET /api/worktrees` | None | Returns a snapshot of every worktree with its ports, URLs, managed records, and observed ports. |
| `GET /api/events` | None | A Server-Sent Events stream that sends the same snapshot as a `snapshot` event on connect and whenever it changes. |
| `POST /api/worktrees` | `branch` | Creates a worktree for the branch through `wt switch`, running the project hooks. Returns 400 for an empty name or one starting with `-`, and 409 with Worktrunk's error when it refuses. A branch that already has a worktree returns it with `action: "existing"`. |
| `POST /api/worktrees/<id>/start` | `service`, `sample-data` | Starts services. Returns 400 when the worktree has no `.env`. |
| `POST /api/worktrees/<id>/stop` | `service` | Stops services and clears their ports. |
| `POST /api/worktrees/<id>/recycle` | `service`, `sample-data` | Stops and starts services. |
| `POST /api/worktrees/<id>/open-log` | `service` | Opens the latest log of a service in VS Code. |
| `POST /api/worktrees/<id>/open-editor` | None | Opens the worktree in VS Code. |
| `POST /api/worktrees/<id>/reseed-data-dir` | None | Runs the `copy-data-dir` hook with `--force` to replace the data directory with a fresh copy from the main worktree. |
| `POST /api/worktrees/<id>/remove` | `force` | Removes the worktree through `wt done`, or `wt remove --force` with `force=1`. Returns 409 with the reason when it keeps the worktree. |

`service` is one service name, or a group: `both` for the backend and web UI (the default), `docs` for both books, `senders` for both sender examples, or `all`. `SERVICE_SELECTORS` in the dashboard client defines the groups, and the API and every client share it. `sample-data=1` starts the backend with generated sample show data.

The API refuses to remove the primary worktree or the checkout running the dashboard.

## Clients

`worktree-dashboard/dashboard-client.mjs` is the one client library for code outside the browser. It resolves the dashboard address, expands group selectors into service names, sends actions, waits for startup, and reduces a snapshot to a summary with one status phrase per service. The `wt service` alias and the MCP server both use it, so add new API calls there instead of calling `fetch` in either one.

The dashboard page is a Solid app in `webui/worktree-dashboard.tsx`. The Vite dev server proxies `/worktree-api` to the API's `/api`, so the page needs no cross-origin setup. It loads `GET /api/worktrees` once, then follows `GET /api/events` and closes that stream while its tab is hidden. It keeps its own types for the snapshot, so a new field in the API needs a matching type on the page.

## In the code

| Location | Description |
|---|---|
| `.config/wt.toml` | Worktrunk hooks and aliases. |
| `scripts/allocate-worktree-port.mjs` | Picks a port block no other worktree uses. |
| `scripts/setup-env.mjs` | Writes `.env` with the port it is given. |
| `scripts/seed-data-dir-from-main.mjs` | Seeds or re-seeds the data directory. |
| `scripts/claude-worktree-hook.mjs` | Routes Claude Code worktrees through `wt`. |
| `scripts/worktree-done.mjs` | The `wt done` alias. |
| `worktree-dashboard/worktree-dashboard.mjs` | The dashboard API, service definitions, and process management. |
| `worktree-dashboard/state-stream.mjs` | The snapshot event stream for the page. |
| `worktree-dashboard/worktree-create.mjs` | Worktree creation for the API and the Claude Code hook. |
| `worktree-dashboard/worktree-remove.mjs` | Worktree removal for the API. |
| `worktree-dashboard/dashboard-client.mjs` | Shared client for the alias and the MCP server. |
| `worktree-dashboard/worktree-service.mjs` | The `wt service` alias. |
| `worktree-dashboard/worktree-dashboard-mcp.mjs` | The MCP server. |
| `webui/worktree-dashboard.tsx` | The dashboard page. |

## Related topics

- [Working in worktrees](../contributing/worktrees.md)
- [How the pieces fit together](system-overview.md)
- [CI builds](../contributing/ci-builds.md)
