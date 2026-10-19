# Board

{{#include ../../includes/human-review-disclaimer.md}}

A Board panel shows one board, named in its tab. Open boards from [Boards](boards.md), the object palette, or **New Board** in the Command Palette. You can open several boards side by side and keep Board panels in saved layouts next to any other panel.

## Operating

In **Operate** mode, pressing a button runs that object's usual action:

- **Clip:** start it, or stop it if it is running.
- **Group:** select it in the Programmer.
- **Blueprint:** apply it to the current selection, or release it if it is already applied.
- **Master:** toggle it.

Buttons light up from the live show, so they stay correct when something changes from the command line or another device. A blueprint button is half-lit when only part of the selection carries it. A button whose object was deleted has a dashed outline.

A frame or collection set to **Solo** lets only one of its buttons be on at a time: pressing another button releases the one that was on, and pressing the lit button releases it. This suits color and position pickers.

## Editing

Switch to **Edit** with the Operate / Edit switcher in the panel toolbar. The gear at the right end opens the board's settings, where you can rename or delete it. While editing, the board shows a grid of small square cells across the whole panel, and elements snap to it.

Add elements from the **+** menu, drag across empty cells to add one sized to that area, or right-click an empty cell. A board can hold:

- **Buttons** pinned to a clip, group, blueprint, or master.
- **Collections** that fill themselves from a filter, such as "blueprints 1-10 whose label contains wash", and pick up matching objects as they are created.
- **Frames** that group buttons under a title.
- **Labels** for notes and headings.
- **Tempo** pads that show the show tempo with its beat dots. Pressing one in Operate mode taps the tempo; see [Show tempo and tap tempo](../tempo.md).

You can also drag clips, groups, blueprints, and masters straight onto a board from their own panels, in either mode; a highlight shows where the button will land.

Drag an element to move it, and drag its corner handle to resize it. Elements can't overlap: a drag stops at the last free spot. Frames may sit over other elements and move by their title bar. With the keyboard, arrow keys move the selected element, Shift+arrows resize it, and Delete removes it. Ctrl/Cmd+C, X, and V copy, cut, and paste elements, including between boards.

Each element has a gear for its settings (target, label, color, filter, Solo, and whether a frame or collection shows its title) and a right-click menu with Solo, Show title, Cut, Copy, Paste, and Remove. Properties shows the same settings for the selected element, or for the board when nothing is selected.
