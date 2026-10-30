# Working in worktrees

{{#include ../includes/human-review-disclaimer.md}}

You can work on several branches at once, each in its own Git worktree with its own ports, data directory, and running app. [Worktrunk](https://github.com/max-sixty/worktrunk) (`wt`) creates and removes the worktrees, and the worktree dashboard starts and stops each worktree's services. This page shows you how to use both. To learn how they work inside, see [worktree tooling](../architecture/worktree-tooling.md).

Both tools are optional. A single checkout set up as described in [Nightfall setup](https://github.com/stewartadam/nightfall-lightdesk/blob/develop/CONTRIBUTING.md#nightfall-setup) works without them.

## What each worktree gets

Every worktree has its own `.env` file, and its `NIGHTFALL_PORT` is the first port of a block of 10 ports that no other worktree uses. Each service listens at a fixed offset in that block:

| Service | Port | Runs |
|---|---|---|
| `backend` | `NIGHTFALL_PORT` | `cargo run` |
| `ui` | `NIGHTFALL_PORT + 1` | `pnpm run dev` |
| `docs-user` | `NIGHTFALL_PORT + 2` | `mdbook serve docs`, the user manual |
| `docs-dev` | `NIGHTFALL_PORT + 3` | `mdbook serve docs/internal`, this guide |
| `wasm` | None | `pnpm run wasm:bridge --dev`, a one-off build |
| `artnet-sender` | None | The Art-Net sender example |
| `sacn-sender` | None | The sACN sender example |

Ports `+4` to `+9` are free for future services. Secondary worktrees also get their own `NIGHTFALL_DATA_DIR`, seeded from the main worktree, and have sACN and Art-Net input and output turned off so two backends never fight over the network.

## Create a worktree

To create a worktree for a new branch:

1. From any checkout of the repository, run:

   ```shell
   wt switch --create <branch>
   ```

1. Wait for the hooks to finish. The pre-start hooks write `.env`, run `pnpm install`, and generate the TypeScript types before `wt` switches to the worktree. The post-start hooks then copy the data directory, web UI assets, and demo audio, and build the backend and WASM bridge in the background.
1. Check the hook output before you start services. A background `cargo build` may still be running.

`wt` reads these hooks from `.config/wt.toml`. They assume the tools from [Nightfall setup](https://github.com/stewartadam/nightfall-lightdesk/blob/develop/CONTRIBUTING.md#nightfall-setup) are installed, including `pnpm run setup:tools` for mdBook.

Claude Code creates worktrees for `claude --worktree`, desktop and Remote Control sessions, and isolated subagents. The `WorktreeCreate` and `WorktreeRemove` hooks in `.claude/settings.json` send those through `wt` too, so they get the same setup. Their branches are named `claude/<name>` and start from `origin/HEAD`.

## Start and stop services

The dashboard API is one long-running process that starts, stops, and watches the services of every worktree. Start it from your main checkout and leave it running:

```shell
pnpm run dashboard
```

You then manage services from the dashboard page, the terminal, or an agent.

### From the dashboard page

Run `pnpm run dashboard:ui` in a second terminal. It opens `/worktree-dashboard.html` in a Vite dev server. The page lists every worktree with its branch, ports, and the state of each service, refreshes every 2 seconds, and has buttons to start, stop, and restart services and to open each service's log. Its **More actions** menu opens the worktree in VS Code, re-seeds its data directory from the main worktree, and deletes it.

### From a terminal

The `wt service` alias talks to the same API. It acts on the worktree you're in, or on another one with `wt -C <path>`:

```shell
wt service list                       # every worktree with its ports and status
wt service status                     # services of this worktree, with URLs
wt service restart                    # restart this worktree's backend and wait
wt service start -s docs              # preview both books
wt -C ../other service stop -s all
```

`start`, `stop`, and `restart` target the backend unless you name services with `-s`. The `docs` group names both books and `all` names every service. `start` and `restart` wait until each service answers on its port, print the log tail of any service that fails, and exit with an error. Run `wt service --help` for every option.

### From an agent

`pnpm run dashboard:mcp` runs an MCP server with the same controls. Agents call `dashboard_list_worktrees` to find their worktree path, then `dashboard_worktree_status` and `dashboard_worktree_manage`. CONTRIBUTING.md has an [example MCP configuration](https://github.com/stewartadam/nightfall-lightdesk/blob/develop/CONTRIBUTING.md#running-nightfall).

## Remove a worktree

When a branch's work has landed, run `wt done` in its worktree, or `wt done <branch>` from another one. It removes worktrees whose commits are in `origin`'s default branch or in a merged pull request, and keeps the rest with a list of their unmerged commits. To throw work away, use `wt remove --force` or hold <kbd>Shift</kbd> and choose **Force delete** on the dashboard page.

Before any removal, the pre-remove hook runs `wt service stop -s all --best-effort`. It gives up after 5 seconds and never blocks removal, and it succeeds when no dashboard is running.

## Add or change a service

A service appears in several places, and a change that misses one leaves a client that doesn't know the service. When you add a service or change one's port, update all of these:

- `SERVICE_DEFINITIONS`, and for a service with a port, `SERVICE_PORT_OFFSETS` and the port probes in `collectWorktreeState`, in `worktree-dashboard/worktree-dashboard.mjs`.
- `WORKTREE_MANAGED_SERVICES`, `SERVICE_SELECTORS`, `summarizeWorktree`, and `observedOpenForService` in `worktree-dashboard/dashboard-client.mjs`. The `wt service` alias and the MCP server both read these.
- The list and status output in `worktree-dashboard/worktree-service.mjs`, and the tool descriptions in `worktree-dashboard/worktree-dashboard-mcp.mjs`.
- The types, service options, and row cells in `webui/worktree-dashboard.tsx`.
- The port block comment in `scripts/setup-env.mjs`, if you use a new offset.
- `.config/wt.toml`, if worktree setup must build or install something for the service.
- The tests in `scripts/dashboard-env.node.test.mjs`, `scripts/worktree-service.node.test.mjs`, and `webui/e2e/worktree-dashboard.spec.ts`.
- This page and the worktree section of CONTRIBUTING.md.

Restart the dashboard API after editing it. It has no hot reload, and restarting it stops every service it started.

## Troubleshooting

### A service doesn't start

Run `wt service start -s <service>`. It prints the error and log tail. Every service writes its log to a new file under `nightfall-worktree-dashboard` in the system temporary directory, and the log button next to each service on the dashboard page opens it.

- `spawn mdbook ENOENT` means mdBook isn't on the dashboard's `PATH`. Run `pnpm run setup:tools mdbook`, then restart the dashboard so it picks up the new `PATH`.
- `needs a valid NIGHTFALL_PORT in .env` means the worktree has no `.env` or no port. Run `node scripts/setup-env.mjs` in that worktree.

### The status says "external process detected"

Something the dashboard didn't start is listening on the service's port. That's often a server you started by hand, or one left over from a dashboard that was killed before it could stop its services. `start` leaves it running and reports it as unmanaged. `stop` and `restart` stop whatever listens on the port.

### A service name or column is missing

`wt service` runs the copy of its script in the worktree you're in, while the dashboard API runs the copy in the checkout you started it from. When the two come from different versions, the alias can reject a service name the API knows, or leave out a column. Rebase the worktree's branch onto `develop`, and after you pull changes to `worktree-dashboard/`, restart the dashboard API.

### `wt service` says no dashboard is running

The alias needs `pnpm run dashboard`. If the API runs on another address, set `NIGHTFALL_WORKTREE_DASHBOARD_URL`, or `NIGHTFALL_WORKTREE_DASHBOARD_HOST` and `NIGHTFALL_WORKTREE_DASHBOARD_PORT`. The default is `http://127.0.0.1:4780`.

### Claude Code fails to create a worktree

The Claude Code hook bases new branches on `origin/HEAD`, which must point at `develop`. Run `git remote set-head origin develop`, then check `.git/wt/logs/commands.jsonl` for the hook that failed.

## Related topics

- [Worktree tooling](../architecture/worktree-tooling.md)
- [Building the documentation](https://github.com/stewartadam/nightfall-lightdesk/blob/develop/CONTRIBUTING.md#building-the-documentation)
- [Worktrunk documentation](https://worktrunk.dev)
