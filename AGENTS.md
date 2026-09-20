# Agent instructions

## General guidance

- Author git commits with signoff.
- Git hooks run on commit and push which compiles the rust project and runs tests, which can take a few minutes. Push is not hanging. Do not try to circumvent this.
- Do not aim for backwards compatibility.
- We prefer architectures promoting long-term maintainability, responsiveness, and readable code.
- Prefer using existing libraries & patterns in the codebase over building custom solutions from scratch. Check what dependencies/utilities are already available before proposing a new implementation.
- Use Bevy `SystemParam`s to resolve mutually exclusive SystemParam conflicts or encapsulate complex sets of system dependencies.
- Questions are just that, questions. Answer the question, do jump straight to implementation.

## Command execution

- Use the patch tool for source and test edits. Do not use Python, Node, or shell redirection merely to write files.
- Omit `2>&1` unless combining streams is necessary for the command's behavior.
- Prefer direct commands and the execution tool's working-directory parameter over unnecessary shell wrappers or `cd` chains.
- Run Playwright only through the repository wrapper described below.

## Cloud agent setup

When running remotely, check `CONTRIBUTING.md` subsection *Nightfall setup* for setup instructions.

Issue numbers provided are tracked by beads, to configure:

```bash
npm install -g @beads/bd
bd init --branch beads-sync --actor agent
```

## Local setup

- The backend is accessible on NIGHTFALL_PORT and frontend at http://localhost:{NIGHTFALL_PORT+1}, `.env` defines NIGHTFALL_PORT.
- Do not switch CARGO_TARGET_DIR. If the shared build directory is locked, it's because CPUs are tied up building anyways.
- When using the `oraios-serena - Activate Project` tool, ensure you use the current worktree path if applicable.
- Use the MCP tools `dashboard_worktree_status` to verify server statuses and `dashboard_worktree_manage` to manage app processes.
- Only attempt to start the services yourself if (a) a process is not already bound its port and (b) these MCP tools are not available.
  - Before starting/stopping managed services, record current status for the worktree.
  - Only stop services that you personally started during the current turn.
  - If a service was already running at the start of the turn, leave it running at completion unless the user explicitly asks you to stop it.
  - When reporting completion, mention any services left running.

### Protected-branches task workflow

When the user provides implementation tasks while the current worktree is on `main` or `develop`, default to this workflow:

1. Create one isolated worktree per task with `wt switch --create <task-slug>`.
2. Track each task in `bd`; mark active work `in_progress`.
3. Keep each worktree, branch, and commit focused on one small task or tightly related set of changes.
4. Work the task to completion in its worktree.
5. Validate with the relevant quality gates, including Playwright for UI-facing changes and Cargo tests for Rust changes.
6. Commit the validated changes
   - When committing changes, do not add untracked files unless you created them.
7. Perform a formal review pass before handing work back.
   - Use the review skill/workflow (`/review` when available); do not substitute an implicit sanity check.
   - Surface review findings explicitly in the handoff, ordered by severity with file/line references when applicable.
   - If there are no findings, say that clearly and note any remaining test gaps or residual risk.
8. Stop before pushing the branch or opening a PR so the user can review, manually test, and guide the next direction.

When the user explicitly asks to work on multiple items in parallel:

1. Split the request into independent items, with one `bd` issue and one `wt` worktree per item.
2. Use parallel agents/workers only when the items have clearly disjoint ownership and can be validated independently.
3. Keep status, tests, review findings, and handoff notes separate per worktree.
4. Do not merge items together unless the user explicitly directs it.

When work or follow-up work was initiated within a worktree, let the user decide when to initiate a review.

## Lifecycle commands

The backend is accessible on NIGHTFALL_PORT and frontend at http://localhost:{NIGHTFALL_PORT+1}, `.env` defines NIGHTFALL_PORT.

- `npm run lint` - run biome lints
- `npm run typecheck` - run tsc to validate typescript
- `npm run typeshare` - export typeshare types from Rust to TS
- `npm run wasm-build:dev` - rebuild WASM binaries (in particular after adjusting command parsing)

## Comments

- When adding debug prints, always prefix them with a `// Debug` comment so we can find and remove them later.
- Do not leave comments like `// foo now handles bar` or `// foo now lives in bar`.
- Include docstrings for ALL functions (public or not), solidjs effects and memos (inline jsdoc syntax), and tests.
  - Docstrings should describe the method's purpose and behavior, not a low-effort sentence version of the method name.

## Web UI logging

- Log messages at the appropriate level using the LogLayer logger abstraction (`lib/logger.ts`), not `console.log`. Loggers should be created via `const log = getLogger(import.meta.url);`.
- When debugging, you can enable console messages for specific modules via `nightfallLog.setModuleLevel('foo', 'debug')`, or several at once via `nightfallLog.configure('warn,foo=debug,bar=trace')`.

## Application data

Application data (fixtures, fx modules, showfiles, etc) can be found at:

- Linux: ~/.local/share/nightfall/fixtures/
- MacOS: ~/Library/Application Support/com.nightfall.nightfall/fixtures/
- Windows: %APPDATA%\nightfall\fixtures\

## Interacting with the Browser/UI

- Validate changes in the UI flows with Playwright. If you need interaction instructions, ask.
- Run browser automation through the repo wrapper instead: `npm run test:webui-playwright -- <spec-or-dir> [--grep <pattern>]`.
  - Use `--target embedded-demo` for browser-demo tests that do not need a native backend; the default is `--target native`.
  - On macOS, run browser-launching Playwright commands using approved escalated execution outside the agent sandbox, including both headed and headless runs. Request escalation before the first launch.
  - If escalation is unavailable, provide the wrapper command for the user to run in Terminal. Do not retry browser launches inside the sandbox after an application-registration failure (`_RegisterApplication`, `TransformProcessType`, or `SIGABRT`).
  - The wrapper rejects browser launches on macOS when `CODEX_SANDBOX=seatbelt`. Do not unset or override this indicator to bypass the guard; it does not remove the operating system's restrictions. Help, installation, and test listing remain available inside the sandbox; put `--help` or `--list` immediately after the command (for example, `npm run test:webui-playwright -- --list`).
  - Playwright browser path is already configured in `.env`, don't try to override it.
  - Do not use ad hoc Playwright invocations such as `node -e 'const { chromium } = require("playwright"); ...'`.
  - Remember to stop timeline playback once at the end of your test if you start it for a test so it doesn't keep running in the background.
- For one-off interactive checks, add or update a spec under `playwright/tests/` and run it with `npm run test:webui-playwright -- --headed <spec>`.
- Reuse Playwright artifacts under `test-results/playwright/` for screenshots, traces, and debugging instead of hand-rolled scripts.
- The frontend takes 2-3s on page load to connect to the backend.
- Clicking the Search icon in the top toolbar (or Ctrl/Cmd+Shift+P) opens the Command Palette, which is the primary way of opening panels.
- The 'Properties' panel will display content relevant to the active panel.
- *Visually* validate your work. Console logs are not enough, since render bugs show code paths executing but the visualizer not updating as we'd expect.
- If you need to validate raw data received by the websocket, all nanostores are available under `window.appStores`.

# Validating your changes

- Validate workflows in Playwright (see above)
- Commit your work after validating it works using conventional commit format, e.g. `feat(component)`, `refactor(component)`
  - Format component names using `engine:crate-name` or `webui:panel-name` for changes to engine or web UI respectively, e.g. `feat(engine:fixture-library)` or `refactor(webui:visualizer)`.
  - Commit messages should have a one-line summary alongside a description of changes.
- When opening pull requests, use the same conventional commit naming style for the PR title.
  - Do not prefix PR titles with `[codex]` or other agent markers.
- If commit fails, resolve and retry until it succeeds
- Use 'bd' for tracking work you skipped for implementation later

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.
<!-- END BEADS CODEX SETUP -->
