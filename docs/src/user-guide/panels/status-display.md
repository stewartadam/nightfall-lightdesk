# Status Display

{{#include ../../includes/human-review-disclaimer.md}}

Status Display summarizes running playback instances. Open it from the Command Palette during operation or while debugging playback.

Use the displayed instance identity, source, state, and timing to distinguish active playback from a stored clip definition. A sequence or FX can have running instances even when its editor is closed. Releasing instances may remain visible while their release finishes.

Use **Stop instance** to stop a specific running instance. Confirm the source before acting when several playbacks are active. For normal operation use the clip's own controls; this panel is useful when you need to find a playback affecting output.

The Timecodes section also shows clock position, rate, source, and state, with **Start timecode**, **Pause timecode**, and **Stop timecode** controls. Check the clock label before using them because a timeline may follow that clock.

If an expected playback is absent, check the clip source and command errors. If it is present but the fixture does not respond, inspect [Layers](layers.md), [Programmer](programmer.md), and [Masters](masters.md).
