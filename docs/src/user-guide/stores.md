# Storing and recalling looks

{{#include ../includes/human-review-disclaimer.md}}

The programmer holds your current selection and live attribute instructions. Storing copies programming into a show object so it can be recalled or played later. A stored cue is not a screenshot of everything currently on stage: output from other playback layers is separate from the programmer's instructions.

## Store a cue

Use **Store cue** in Programmer. Choose the sequence and cue IDs and a label, then confirm. A cue ID such as `1.2` means cue `2` in sequence `1`.

From the command input:

```text
store cue 1.2
```

When storing over an existing cue, choose the behavior deliberately:

| Mode | Effect |
| --- | --- |
| Default / replace | Replace the target's stored programming with the current programmer content. |
| `/merge` | Add programmer instructions and overwrite matching stored attributes while retaining other programming. |
| `/update` | Update matching existing programming without adding new attributes. |
| `/remove` | Remove matching attributes identified by the programmer from the stored cue. |

For example, `store cue 1.2 /merge` changes a subset without rebuilding the entire look. Inspect the result in Cue Editor, especially after bulk stores or stores involving multi-element fixtures.

## Selection and reusable values

**Store group** saves a fixture selection, including ordering used by effects; it does not save a lighting look. **Blueprints** store reusable attribute values. Normal blueprint recall retains references, so updating the blueprint can update dependent programming. Absolute recall copies concrete values instead. Use References to inspect dependencies before changing or removing shared values.

Do not assume a fixture is stored simply because it is visible in Programmer: selected fixtures can have empty attribute cells. Review the instructions you intend to keep.

## Check the result

After storing, clear the programmer and play the cue's sequence through a clip. Saving a cue changes the working show; use **Save Showfile** to save that show to disk. Use Undo Stack to inspect reversible editing operations, and keep a saved revision before broad changes.
