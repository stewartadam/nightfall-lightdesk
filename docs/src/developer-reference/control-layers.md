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
- `register_momentary_command_action` lowers the press and the release of a held
  control to separate tracked commands, such as `clip.hold` starting a clip on press
  and stopping it on release.
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
the command palette or switching panels. UI actions share the action ID namespace
(`ui.*` is reserved for them) and the binding model, but run in the browser.
Hardware mappings to `ui.*` actions are forwarded to connected clients that opt
in.

## Choosing a layer

- A person should be able to bind it: register an **action**.
- The Web UI or command line asks for a change: send a **command**.
- A value streams continuously from a fader or slider: send an **update**.
- A command handler has resolved concrete work: emit an **engine operation**.
- A system needs to notify other systems: write a **message**.
