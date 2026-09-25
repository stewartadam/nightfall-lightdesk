# Control layers: actions, commands, updates, and operations

Nightfall has several ways to make the engine do something. Each has one job, and
the layers stack rather than compete. Choose the layer by who initiates the work
and whether it must be tracked, undoable, or bindable.

| Layer | What it is | Produced by | Tracked | Undo |
|---|---|---|---|---|
| **Action** | Named, described, bindable entry point (`ActionId` + typed arguments) | MIDI/OSC mappings, keybindings, timeline events, command palette | Through the command it lowers to | Through the command it lowers to |
| **Command** (`IngressCommand`) | Wire-level user intent, such as `ClipCommand::GoClip` | Web UI JSON, the desk command language, actions | Yes (`CommandTracker`, `CommandResult`) | Yes, when the type is registered with `UndoRegistry` |
| **Update** | Untracked continuous state, such as `ControlUpdate` | Web UI `sendUpdate`, absolute actions | No | No |
| **Engine operation** (`EngineOperation`) | Resolved internal work, such as `ClipOperation::Start` | Command handlers and engine systems | Inherits the command's lifecycle, or is detached | At the operation stage, when registered |
| **Message** | Internal Bevy notification | Engine systems | No | No |

## Actions

Actions are the user-facing vocabulary: anything a person can bind to a MIDI
control, OSC address, keyboard shortcut, or timeline event. They are **not** a
separate execution path. A domain plugin registers an action with
`nightfall_actions::ActionAppExt` and describes how it lowers:

- `register_command_action` lowers trigger input to one tracked ingress command.
  The command is registered under `CommandOrigin::Automation` and queued through
  `PendingCommandBuffer`, so it receives the same undo capture, lifecycle
  tracking, and result reporting as a command sent by the Web UI.
- `register_update_action` lowers absolute input (a normalized `0.0..=1.0`
  value) to an update message. Continuous hardware input is live performance
  state and is never undoable: a physical fader cannot follow an undo.
- `register_action` is the escape hatch for actions that orchestrate around the
  command path. Route any discrete work through `submit_command`.

Actions never write engine operations directly. When a button in the UI and a
mapped hardware control should behave identically, both send the same command;
orchestration that decides *which* command to send belongs in the backend
command handler, not in the UI.

### Descriptors

Every action has an `ActionDescriptor`: a stable ID, label, category, optional
description, an input kind, and typed parameters. The input kind decides which
controls can drive it:

- `Trigger`: fires once. Button presses fire it and releases are ignored.
- `Momentary`: reacts to both press and release.
- `Absolute`: consumes a normalized value from a fader or knob.

Parameter kinds (`Clip`, `Master`, `Control`, `Timeline`, `Cue`, `Panel`,
`Integer`, `Number`, `Text`) tell clients which picker to render and which UI
target a click can capture.

### Surfaces

Every invocation carries the `ActionSurface` it came from (timeline, MIDI, OSC,
command palette, keyboard, or websocket). Descriptors list the surfaces allowed
to bind and invoke the action; all of them by default. Domains restrict an
action that only makes sense in one context with
`ActionDescriptor::with_surfaces`, such as `timeline.fire-cue`, whose transient
playback lasts for the timeline action that placed it and is timeline-only.

The restriction is enforced in three places:

- `ActionRegistry::invoke` rejects invocations from other surfaces with
  `action.surface_not_allowed` before the domain runs.
- `ActionRegistry::validate_binding` takes the binding's surface, so MIDI and
  OSC mapping upserts fail with the same code.
- The catalog publishes each descriptor's `surfaces`, and Web UI pickers,
  the command palette, and controller mapping mode only offer actions allowed on
  the surface being bound.

### Controller behaviors

Each MIDI or OSC mapping has a `ControlBehavior` that decides how the control's
presses and releases invoke its action:

- `Press` fires a trigger on press, and lets faders drive absolute actions directly.
- `Release` fires a trigger when the control is let go.
- `Hold` invokes the action on press and its release counterpart on release, with the
  same arguments. Domains declare the counterpart with
  `ActionDescriptor::with_hold_release`, such as `clip.start` with `clip.stop`.
- `Flash` pushes an absolute action to full while held and restores the previous level
  on release. Domains enable it with `register_flash_level`. Stacked flashes restore
  after the last release, and a level moved during the flash wins.

Behaviors never decide undo: that follows the command each invoked action lowers to.
A control holds one binding reacting to both edges, or one Press and one Release
trigger binding. The action catalog lists each action's supported behaviors. OSC
buttons report releases when their mapping names both the pressed value (`arg_value`)
and the released value (`release_value`).

### Invocation failures

Registry and domain failures are `InvocationError`s: a stable `code`, an
operator-facing `message`, and optional structured `details` (such as the missing
clip or master UID), mirroring `CommandError`. The dispatcher reports them to clients
so a binding that stops working is never silent:

- Each failure is broadcast as a non-droppable `ActionInvocationFailed` message
  carrying the action reference, surface, source label, raw input, and error.
  Successful invocations are not broadcast; commands they submit already report a
  `CommandResult`.
- Discrete input (triggers, presses, releases) reports every failure. Continuous
  scalar input is throttled by `InvocationFailureThrottle`: per surface and action
  reference, a failure is reported when it is the first, when its code changes, or
  after `FAILURE_REPEAT_WINDOW` (5 s) has elapsed; any non-failed outcome resets the
  binding. A fader bound to a deleted master therefore reports once per window,
  not once per movement.
- `ActionCommand::Invoke` stays active until its invocation is dispatched on the
  next frame and finishes with the invocation's outcome: a rejection fails the
  command with the same code, message, and details, and any other outcome succeeds
  with the serialized `InvocationOutcome` as output. The failure broadcast carries
  the command's `command_id` and is sent before its `CommandResult`.
- The Web UI keeps recent failures in the `actionInvocationFailures` store and
  shows a toast titled with the action's catalog label. Fader failures are
  short-lived warnings. When a failure finished a client command, that toast
  replaces the generic command failure toast.

### Capabilities

Optional, deterministic interpretations of an action are registered as
capabilities keyed by their output type and published by name in the action
catalog. The timeline uses the `timeline.plan` capability
(`TimelinePlaybackActionPlan`) to plan and seek actions without running them. A
trigger action without that capability can still run from the timeline live, but
seeking skips it.

### Ownership

`nightfall-actions` knows nothing about any domain. Each domain registers its own
actions from its own plugin; registration helpers initialize the registry, so
plugin order does not matter. There is no crate that enumerates every action.

### UI actions

The Web UI has its own action registry for browser-local behavior such as opening
panels or the settings dialog. UI actions share the action ID namespace (`ui.*` is
reserved for them) and the binding model, but run in the browser:

- Pickers list backend catalog actions and this client's UI actions together, so
  MIDI, OSC, and keyboard bindings can target either.
- The backend accepts `ui.*` bindings without a registration. When a MIDI or OSC
  mapping fires one, it broadcasts a `ClientActionInvocation`; each client runs it
  only if its "Run UI actions triggered by MIDI and OSC mappings" setting is on.
- User keybindings are stored per browser. A keybinding to a backend action sends an
  `ActionCommand::Invoke` with the keyboard surface.
- In controller mapping mode, choosing a command palette entry binds the armed
  control to that entry instead of running it.

## Choosing a layer

- A person should be able to bind it: register an **action**.
- The Web UI or command line asks for a change: send a **command**.
- A value streams continuously from a fader or slider: send an **update**.
- A command handler has resolved concrete work: emit an **engine operation**.
- A system needs to notify other systems: write a **message**.
