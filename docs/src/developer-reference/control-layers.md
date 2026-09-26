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

An OSC mapping that reads an argument without matching a value turns numbers into a
level. With no `range`, floats within `0..1` are read as normalized and other numbers as
percents. An explicit `range` (`min`, `max`; `min > max` reverses travel) maps values
linearly onto `0..1` and clamps, so a fader sending integers `0..127` sets
`{ min: 0, max: 127 }`. Upserts reject non-finite or empty ranges with
`osc.invalid_range`, which diagnostics also report for loaded mappings. The press
threshold for edge-driven actions applies to the normalized level.

### Mapping edit undo

`UpsertMapping` and `DeleteMapping` for MIDI and OSC are undoable through one shared
mechanism in `nightfall-actions` (`binding_undo.rs`). A mapping resource implements
`BindingStore`, and `register_binding_undo` registers the domain command together with a
`RestoreBindings<S>` engine operation:

- The command's inverse (`capture_binding_edit`) applies the edit to a copy of the store
  and snapshots every affected mapping on both sides: the upserted or deleted mapping plus
  any mappings an upsert displaced, with their list positions before the edit.
- Undo removes what the edit left and reinserts the snapshots at their former positions,
  so list order is restored exactly. Its inverse is the opposite restore, which is redo.
- A restore requires the edit's result to still be stored unchanged, and a reinserted ID
  to be free. Otherwise its inverse is unavailable and undo or redo fails with
  `undo.state_conflict` / `redo.state_conflict`, leaving history and mappings untouched.

An upsert that displaces mappings returns them as `MidiMappingUpserted` /
`OscMappingUpserted` (`replaced`), and the Web UI names them in its confirmation toast.
Replacing every mapping at once (`set_mappings`) only happens on showfile load and sample
data, is not a command, and is not undoable.

### Controller mapping mode

Mapping mode lets an operator touch a MIDI or OSC control and click a UI control to bind
it. Touching an already-mapped control must not fire its live action, so the backend
pauses controller dispatch while any client is mapping:

- Clients send `ActionCommand::EnterControllerMappingMode` and
  `LeaveControllerMappingMode`. `ControllerMappingMode` holds the set of mapping client
  sessions; controllers are paused while it is non-empty, so several clients can map at
  once. Entering again is harmless, and the Web UI re-sends it after reconnecting.
- Each hold is a lease. The Web UI sends `RenewControllerMappingMode` every 5 seconds
  while mapping, and the backend ends a hold not renewed within `MAPPING_MODE_LEASE`
  (15 seconds), so a frozen or throttled window cannot keep controllers paused. Renewals
  bypass change detection, so they do not rebroadcast mapping state.
- Sessions are identified by `ClientConnectionId`, which the host adapter stamps on each
  command it submits (`CommandTracker::connection`). The websocket host reports ended
  sessions through `ClientBridgeHost::disconnect_sender`, and the engine turns them into
  `ClientDisconnected` messages that release that session's hold. The embedded browser
  runtime has one session, `ClientConnectionId::EMBEDDED`. Commands without a session,
  such as HTTP routes, cannot hold mapping mode.
- A lapsed lease is remembered for its session, whose next renewal fails with
  `action.mapping_mode_ended`; the Web UI then leaves mapping mode and shows why. A
  renewal from a session without a lapsed lease simply enters, which covers a reconnected
  client renewing before its re-entry arrives, so the Web UI renews rather than re-enters
  after a resync.
- Loading a show ends every session's mapping mode, since it replaces the targets a
  client may be about to bind. A load that swaps worlds also restarts the websocket
  sessions, so clients cannot be told by session. Instead `ControllerMappingModeState`
  carries a `show_generation` that is new for each world and for each in-place load; a
  client that entered under another generation leaves mapping mode and says a show was
  loaded. It is published as text, since binary websocket encodings serialize UUIDs as
  bytes.
- While paused, `SourceEdgeStates` starts nothing new but finishes what already started
  live. Presses, fader levels, pulses, and `Release`-behavior triggers are swallowed. A
  release completing a press that was dispatched before mapping began still dispatches,
  so a `Hold` binding's counterpart runs and a `Flash` restores its level instead of
  latching. A press swallowed while paused also swallows its release, even when the
  release arrives after mapping mode ends, so leaving mapping mode never fires a stray
  release binding.
- The count of mapping sessions is broadcast non-droppably as `ControllerMappingMode`.
  Other clients show a banner that controller actions are paused; the mapping client
  shows whether its pause is confirmed.
- `MidiLastEvent` and `OscLastEvent` telemetry is droppable and coalesced to one event
  per frame, which can lose the control an operator touched. While mapping mode is active
  the backend also sends non-droppable `MidiControlTouched` and `OscControlTouched`
  batches: every MIDI control touched in a frame (its latest message), and every OSC
  message whose address and first argument are new within the frame, capped at 64 per
  frame. The Web UI arms only from these batches, so the press and release values of an
  OSC button arriving in one frame are both recorded.
- MIDI channel messages that cannot drive actions, such as program changes, are touches
  without a `source`, so the mapping banner explains why nothing armed. System messages
  such as clock are never touches.
- Listeners timestamp input on receipt, and only input received after some session
  entered mapping mode is a touch, so a control moved just before entering does not arm.
- Keybindings are not paused: they are client-local, and mapping mode arms from
  controllers, not the keyboard.

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

### Stored binding validation

Bindings are stored `ActionReference`s, so they can outlive what they point at. The
registry validates them on demand, never on each invocation (invokers resolve their
targets themselves):

- `ActionRegistry::validate_reference` checks that the action is registered, that the
  surface may invoke it, and `validate_arguments`: required arguments are present,
  `Integer` and `Number` arguments lie in their declared range, and the arguments decode
  into the owning domain's typed argument struct.
- `ActionRegistry::validate_target` checks that the objects the arguments address exist.
  The domain that owns an object kind registers one read-only validator per
  `ActionParameterKind` with `register_action_target_validator`: desk for `Clip` and
  `Master`, timeline for `Timeline` and `Cue`. Kinds without a validator are accepted.
- Domains call `invalidate_action_targets_when` with a cheap change-detection run
  condition over the state their validators read. It marks the `ActionTargets` resource
  changed in the `ActionTargetTracking` set, after command handling and before client
  output.

MIDI and OSC keep invalid mappings stored, so they recover when their target returns, and
publish `MidiMappingDiagnostics` and `OscMappingDiagnostics`: one `BindingDiagnostic`
(mapping ID and `InvocationError`) per mapping that cannot run. Diagnostics are recomputed
only when `bindings_need_diagnosis` sees the mappings, the registry, or `ActionTargets`
change, and are sent when the result differs and on resync. The MIDI and OSC panels show
them in each row's Status column.

Timeline commands that store actions (`StoreTimeline`, `CreateTimeline`, and
`InsertRecordedActions`) fail when an action is unregistered, not allowed on the timeline
surface, has invalid arguments, or cannot be planned by its timeline capability.
`StoreTimeline` only validates actions that are new or changed, so timelines loaded from
older showfiles stay editable; missing targets are not rejected. When a stored action's
plan fails at playback, `ActionKind::resolve` logs one warning per reference and runs it
as a live action without seek support.

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
