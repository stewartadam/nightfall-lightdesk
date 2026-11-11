# 3. Toasts live inside the frontmost modal dialog and join its keyboard order

- Status: Accepted
- Date: 2026-11-11

## Context

The web UI shows modal dialogs with the native `<dialog>` element and `showModal()`. An open modal dialog sits in the browser's top layer and makes the rest of the page inert: nothing outside it can be seen above it, clicked, focused or read by assistive technology.

Toasts used to mount on `<body>`. While any modal dialog was open (Settings, About, the command palette, startup recovery), toasts drew underneath it and could not be clicked. Feedback raised from inside a dialog, such as "Copied data directory path" in About, was invisible.

Two ways to draw toasts above a modal dialog were considered:

- **A popover in the top layer.** A `popover="manual"` container shown after each dialog opens is drawn above it, but the browser still treats everything outside the modal dialog as inert. A Playwright hit test confirmed that toasts in such a popover can't be clicked.
- **Inside the dialog.** Floating menus, tooltips and pickers already mount inside the frontmost open dialog through `overlayHost()` in `webui/components/ui/modal/dialog-stack.ts`. Content inside the dialog is part of the top layer and is not inert.

## Decision

Toasts mount in one shared container that follows `overlayHost()`. The dialog stack notifies listeners (`watchOverlayHost`) whenever a modal dialog is shown, closed, registered or removed. The container then moves into the frontmost open modal dialog, or back to `<body>` once none is open, and carries the toasts already on screen with it.

Because toasts are then part of the dialog, they are also part of its keyboard and accessibility model:

- **Tab order.** While a toast is showing, Tab inside the dialog also reaches the toast's controls: the dismiss button, any action buttons and the "Don't show this again" checkbox. Toast controls are not removed from the Tab order, so keyboard users can reach toast actions while a dialog is open.
- **Keys.** The container is marked `data-owns-dialog-keys`, so Enter and Escape on a toast control never run the dialog's default action or dismiss it. Escape on a toast control is cancelled, so the browser does not turn it into a close request for the dialog.
- **Timeout.** A toast pauses its countdown while it has focus or the pointer is over it, and starts a full countdown once both leave. Tabbing through a toast does not make it disappear while it is focused.
- **Naming.** The toast's close button is named "Dismiss notification", so it is not confused with the dialog's own "Close" button.
- **Screen readers.** Toasts keep `role="alert"`. Inside a dialog they are announced as part of that dialog.

## Consequences

- Toasts are visible and usable over every modal dialog, and keyboard users can act on them without closing the dialog first.
- While a toast is showing, a dialog has one to three extra Tab stops. They disappear when the toast times out or is dismissed.
- Playwright locators scoped to a dialog, such as `dialog.getByRole("alert")` or a button named "Close", can also match a toast that is open at the same time. Specs that look for a dialog's own content scope to its surface (`dialog.getByRole("document")`), which toasts are never inside.
- Any other long-lived overlay that must stay usable above dialogs follows the same pattern: subscribe with `watchOverlayHost()` and re-home into `overlayHost()`, as the welcome guide's floating card does.
