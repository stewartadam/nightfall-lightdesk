# Keyboard Shortcuts System

This document provides comprehensive documentation for the Nightfall keyboard shortcuts system, which provides a centralized, component-aware approach to handling keyboard shortcuts throughout the application.

## Architecture Overview

The keyboard shortcuts system consists of several components:

1. **Core Utilities** (`keyboardShortcuts.ts`): The main implementation that handles registration, management, and triggering of shortcuts using the `tinykeys` library.

2. **Component Focus Context** (`componentFocusContext.ts`): Tracks which component has DOM focus by monitoring when components register themselves and checking which component's DOM tree contains the active element.

3. **Provider Component** (`KeyboardShortcutsProvider.tsx`): Initializes the shortcuts system and should be placed near the top of your component tree.

4. **Help Panel** (`ShortcutsHelpPanel.tsx`): Displays all registered shortcuts to users.

## Key Features

- **Component Focus Detection**: Shortcuts can be specific to components or global across the application
- **DOM-Based Focus**: Focus is determined by which component's DOM tree contains the currently focused element, enabling shortcuts to work across multiple inputs within a component
- **Centralized Registration**: All shortcuts are registered in one system
- **Conflict Prevention**: Detection and warning for conflicting shortcuts
- **Help System**: Built-in components to display available shortcuts to users
- **Accessibility Support**: Follows keyboard interaction best practices

## Usage

### Setup

Ensure the `KeyboardShortcutsProvider` is included near the top of your component tree:

```tsx
import KeyboardShortcutsProvider from "./components/solid/KeyboardShortcutsProvider";

export function App() {
    return <KeyboardShortcutsProvider>{/* Your application components */}</KeyboardShortcutsProvider>;
}
```

### Registering a Component

Components that want to have focus-aware shortcuts must register themselves with the focus system:

```tsx
import { registerComponentFocus } from "../lib/keyboardShortcuts";
import { onMount } from "solid-js";

function MyEditorComponent() {
    const COMPONENT_ID = "my-editor";
    let containerRef: HTMLDivElement | undefined;

    onMount(() => {
        if (containerRef) {
            return registerComponentFocus(COMPONENT_ID, containerRef);
        }
    });

    return <div ref={containerRef}>{/* Editor content */}</div>;
}
```

### Registering Shortcuts

Register shortcuts using the `useKeyboardShortcut` hook in your components:

```tsx
import { useKeyboardShortcut } from "../lib/keyboardShortcuts";

function MyComponent() {
    // Register a global shortcut
    useKeyboardShortcut({
        key: "?",
        handler: () => console.log("Help requested"),
        description: "Show help",
    });

    // Register a component-specific shortcut
    useKeyboardShortcut({
        key: "Space",
        handler: () => console.log("Component-specific action"),
        description: "Do something in this component",
        componentId: "my-editor",
    });
}
```

### Example: Command Line Component

The command line panel uses component focus to ensure its shortcuts work even when not the active dockview panel:

```tsx
import { registerComponentFocus, useKeyboardShortcut } from "../lib/keyboardShortcuts";
import { onMount } from "solid-js";

function CommandLinePanel() {
    const COMPONENT_ID = "command-line";
    let containerRef: HTMLDivElement | undefined;

    onMount(() => {
        if (containerRef) {
            return registerComponentFocus(COMPONENT_ID, containerRef);
        }
    });

    useKeyboardShortcut({
        key: "ArrowUp",
        handler: () => navigateHistory("prev"),
        description: "Previous command in history",
        componentId: COMPONENT_ID,
    });

    return (
        <form ref={containerRef} onSubmit={handleSubmit}>
            <input id="cmdline" placeholder="Enter command..." />
        </form>
    );
}
```

## API Reference

### `registerComponentFocus(componentId: string, element: HTMLElement): () => void`

Registers a component for focus tracking. Returns an unregister function.

### `useKeyboardShortcut(binding: KeyboardShortcut, options?: KeyboardShortcutOptions): void`

Registers a keyboard shortcut within a component.

```tsx
interface KeyboardShortcut {
    key: string;                    // Keybinding string (e.g., "Space", "Ctrl+S")
    handler: () => void;            // Function called when shortcut is triggered
    description: string;            // Human-readable description
    componentId?: string;           // Optional component ID for component-specific shortcuts
}

interface KeyboardShortcutOptions {
    global?: boolean;               // If true, makes shortcut global
    overwrite?: boolean;            // If true, overwrites conflicting shortcuts
}
```

### `getCurrentFocusedComponent(): string | null`

Returns the ID of the currently focused component, or null if none.

## Key Formatting

Follow the `tinykeys` naming convention:

- `a`, `b`, `c` for letter keys
- `1`, `2`, `3` for number keys
- `Space` for space bar
- `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` for arrow keys
- `Home`, `End`, `PageUp`, `PageDown` for navigation
- `Escape` for escape key
- `$mod+k` for Command/Ctrl+K (platform-aware)

For combinations, use `+`:

- `$mod+s` for Command/Ctrl+S
- `Shift+a` for Shift+A
- `Alt+Space` for Alt+Space

## Best Practices

1. **Descriptive Names**: Always provide clear descriptions for each shortcut
2. **Component Awareness**: Use component-specific shortcuts for context-dependent actions
3. **Consistency**: Follow platform conventions (e.g., Cmd+S/Ctrl+S for save)
4. **Avoid Conflicts**: Don't override browser defaults
5. **Documentation**: Keep the shortcut help panel accessible

