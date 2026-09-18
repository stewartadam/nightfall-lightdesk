# Your first show

{{#include ../includes/human-review-disclaimer.md}}

This tutorial builds two looks, plays them from a clip, and saves the result. Use a new desktop showfile so the example IDs are free. No physical lights are required.

## 1. Create a practice show

Install a build from [Downloads](https://nightfall.live/downloads) and launch Nightfall. In the startup showfile picker choose **New showfile**, or use the application menu's new-show action. Name it `First show`.

Open **I/O Transports** through the Command Palette and leave **Network output** and **USB output** off while practicing. Open **Patch**, **Programmer**, **Properties**, **Sequences**, **Clips**, and **3D Visualizer** as you need them. You can return to the palette at any time with Ctrl+Shift+P / Cmd+Shift+P.

## 2. Add one fixture

Download the [Practice RGBI fixture definition](assets/nightfall@practice-rgbi.json) (save the linked JSON file, preserving its filename). Open **Fixture Library**, choose **Upload fixture**, and select that file. It describes a virtual training light, not a physical product.

In **Patch**, use the add-fixture button to open the wizard:

1. Select **nightfall / Practice RGBI**, then choose its **4 channel** mode. Inspect the parameter preview: intensity, red, green, and blue each use one channel.
2. Set **Quantity** to `1` and **Label** to `Practice light`.
3. Leave **Assign Console DMX** enabled. In **Patch**, enter universe `1` in the **Univ** box and start address `1` in the box after the dot. This only assigns console channels; output is still disabled.
4. Review the mode and channel footprint, then choose **Finish**.

The fixture should appear in Patch and Fixtures. Note its numeric ID; the commands below use `1`. Substitute your fixture's ID if it differs. If the library is empty, install fixture definitions before continuing; see [Fixture Library](panels/fixture-library.md).

## 3. Make a red look

Click the command input in the top toolbar, enter each line below, and press Enter after each one:

```text
fixture 1 @ 100
fixture 1 red @ 100 green @ 0 blue @ 0
```

The first command sets intensity to 100 percent. The second sets RGB color. The Programmer should show the fixture and those values. Open **Fixtures** to see the resulting attribute values and color. The practice OFL profile supplies channel information; detailed 3D geometry is available with suitable fixture profiles, such as GDTF.

You can also edit attribute cells in Programmer directly. If the fixture stays dark, verify its mode exposes these attributes, check the [Masters](panels/masters.md) levels, and inspect [Layers](panels/layers.md) for other output affecting it. Some real fixture modes also need a shutter or other enable attribute.

## 4. Store two cues

In **Sequences**, choose **Add sequence**. Nightfall creates the next available sequence (ID `1` in an empty show) and opens its editor. Open **Properties**, click the Sequence Editor tab again so Properties follows it, change **Sequence label** to `First sequence`, and press Enter. In **Programmer**, click **Store cue**. Set **Sequence ID** to `1`, **Cue ID** to `1`, and **Label** to `Red`; confirm **Store Cue**.

Change the programmer color:

```text
fixture 1 red @ 0 green @ 0 blue @ 100
```

Store again with **Sequence ID** `1`, **Cue ID** `2`, and **Label** `Blue`.

Open sequence `1` from **Sequences**. Its Sequence Editor should contain both cues. Keep **Properties** expanded beside Sequence Editor, then click the **Blue** cue in the editor and set its **Trigger** to **Manual** in Properties. This makes the second cue wait for Go; the default **Follow Previous** advances automatically when the previous cue finishes. Leave fade timing at the defaults for the first playback; once it works, try a longer fade and compare the transition. [Cues and timing](cues.md) explains inherited timing and tracking.

## 5. Play the sequence from a clip

Open **Clips**, choose **Add clip**, and give it ID `1` and label `First playback`. Select the clip and open **Properties**. Set its source to **Sequence** and select `First sequence`.

Clear the programmer before playback. The Programmer toolbar's **Clear programmer** button clears selection first and values on the next press; press it until the programmer values are gone. This is different from setting intensity to zero, which would leave a live instruction.

Right-click the clip and choose **Start Clip**. Check **Status Display** for a running instance and look at the fixture output in **Fixtures**. Enter `clip 1 go` in the command input to advance to the next cue. For a dedicated Go button, drag the clip to an empty control slot in the Clips panel. You should see red and then blue. Stop the clip when finished using **Stop Clip** from its context menu. An active instance can also be stopped from Status Display.

If the look does not change, check that the clip points to the intended sequence, that both cues contain the expected values, and that the programmer is clear. Stop other active playbacks while learning this sequence.

## 6. Save and reopen

Use **Save Showfile** from the application menu. Stop playback before closing the application. Relaunch Nightfall and use **Open Showfile** to expand `First show`. Choose its saved showfile row; if a draft is also present, the saved row is the **Revert to saved showfile** action. This checks the saved version rather than resuming unsaved work.

Check that `Practice light`, the two cues, and `First playback` are still present. Start the clip once more, verify the same looks, and stop it. You now have a saved show you can expand.

Next, store a [Group](panels/groups.md) for repeated fixture selections, try an [FX](panels/fx-editor.md), or place clip actions on a [Timeline](panels/timeline.md). Connect hardware only after reviewing [Patch](panels/patch.md) and [I/O Transports](panels/io-transports.md).
