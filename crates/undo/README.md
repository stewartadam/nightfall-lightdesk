# Undo/Redo System

Console-wide undo/redo functionality for Nightfall lighting control system, implemented using a GURQ algorithm.

## Architecture Decision Record

### Context

The lighting console requires a robust undo/redo system that:

- Works across all command types from registered plugins (e.g. fixtures, cues, fx, programmer state)
- Captures inverse operations before commands execute
- Maintains separate undo/redo stacks with batching support
- Integrates with Bevy ECS without resource access conflicts
- Permits plugins to manage their own undo/redo handling to avoid a dependency web

### Decision

Implemented a **two-phase command dispatch pattern** with **exclusive system processing**:

1. **Inverse Capture Phase** (`process_pending_commands`):
   - Commands enter `PendingCommandBuffer` instead of executing immediately
   - Registry pattern generates inverse commands by calling `UndoableOperation::inverse()`
   - Inverses are pushed to `UndoManager` with batch grouping
   - Original commands are then queued for normal dispatch

2. **Undo/Redo Execution** (`handle_undo_commands`):
   - Exclusive system with `world: &mut World` parameter
   - Uses cached `SystemState` for `MessageReader` to prevent duplicate event processing
   - Accesses all resources through `world.resource_mut::<T>()`
   - Scopes `UndoContext { world }` borrows to avoid conflicts

### Constraints

#### Bevy ECS Limitations

- **Cannot mix** `&World` with system parameters (`ResMut`, `MessageReader`, etc.)
- Must use either:
  - Regular system (system parameters only, no World access)
  - Exclusive system (`&mut World` only, access resources through world)

#### UndoContext Design

- Plugin undo implementations use `ctx.world.resource::<DataProvider<T>>()` to read state
- Requires holding `&World` reference during `inverse()` calls
- Incompatible with simultaneous mutable resource access (e.g., `ResMut<UndoManager>`)
- **Solution**: Scope `UndoContext` borrows within blocks, drop before accessing other resources

### Implementation Details

#### Plugin Integration

Each plugin must register its undoable commands:

```rust
app.world_mut()
    .resource_mut::<UndoRegistry>()
    .register::<MyCommand>();
```

Plugins implement the `UndoableOperation` trait:

```rust
impl UndoableOperation for MyCommand {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        // Read state via ctx.world.resource::<T>()
        // Return inverse command or None if not undoable
    }

    fn description(&self) -> String {
        // Human-readable description for undo history
    }
}
```

**Note:** The `UndoableOperation` trait does not use `typetag` for serialization. Undo commands are generated and dispatched internally within the engine and never serialized over WebSocket.

#### Command Flow

```
User Input → AST Parser → Command Dispatch
                              ↓
                      PendingCommandBuffer
                              ↓
                   process_pending_commands
                    (Capture Inverses)
                         ↙        ↘
                UndoManager      Command Execution
                (Push Undo)      (Original Command)
```

#### Undo/Redo Flow
```
Undo Command → handle_undo_commands
                      ↓
            Pop from Undo Stack
                      ↓
        Generate Redo Inverses (scoped)
                      ↓
        Push to Redo Stack
                      ↓
        Execute Inverse Commands
```

### Rationale

**Why Exclusive System?**
- `UndoContext` requires `&World` access (baked into all plugin implementations)
- Changing this would require refactoring every `undo.rs` across all plugins
- Exclusive systems allow careful borrow scoping to avoid conflicts
- Performance impact acceptable (undo/redo is infrequent, user-initiated)

**Why Two-Phase Dispatch?**
- Must capture state *before* command executes to generate correct inverse
- Registry pattern allows plugins to provide inverse logic without tight coupling
- Batching support groups related commands into atomic undo operations

**Why Cached SystemState?**
- `SystemState::new()` on every call creates fresh state, re-reading all messages
- Bevy caches `SystemState` parameters between invocations
- Prevents duplicate event processing (undo running twice)

### Trade-offs

**Advantages:**
- ✅ No changes to existing plugin undo implementations
- ✅ Clean separation between inverse capture and undo execution
- ✅ Type-safe command dispatch with trait-based inverses
- ✅ Automatic batch management with configurable history limits

**Disadvantages:**
- ⚠️ Exclusive system serializes execution (blocks other systems)
- ⚠️ Commands go through buffer (slight latency increase)
- ⚠️ More verbose resource access in `handle_undo_commands`

### Status

**Implemented** - All core plugins registered, system functional.

### Related Files
- `dispatcher.rs` - Inverse capture and command buffering
- `systems.rs` - Undo/redo command handling
- `manager.rs` - Undo/redo stack management
- `context.rs` - World access wrapper for inverse generation
- Plugin `undo.rs` files - Command-specific inverse implementations

## Further Reading

- [Understanding the GURQ algorithm](https://luke.hsiao.dev/blog/gurq-algorithm/)
- [Resolving the Great Undo-Redo Quandary](https://github.com/zaboople/klonk/blob/master/TheGURQ.md)
