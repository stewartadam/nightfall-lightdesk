// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SPDX-License-Identifier: MPL-2.0

import type { PanelComponentName } from "../../lib/panel-definitions";

export interface GuideStep {
  id: string;
  title: string;
  body: string;
  action: string;
  panels?: PanelComponentName[];
  target?: string;
  hint?: string;
  more?: string;
  observe?: "selection" | "look" | "cue" | "clear";
}

export interface GuideLesson {
  id: string;
  title: string;
  duration: string;
  introduction: string;
  prerequisite: string;
  steps: GuideStep[];
}

export const GUIDE_LESSONS: GuideLesson[] = [
  {
    id: "welcome",
    title: "Your first lights",
    duration: "8–10 min",
    introduction:
      "Select lights, create two looks, and play them with a fader and Go button.",
    prerequisite:
      "Use the demo rig or a practice show with color fixtures. These steps edit the current show. Stop other playback before programming; keep physical output off while practicing.",
    steps: [
      {
        id: "watch",
        title: "See what a show can do",
        body: "The 3D Visualizer shows your lighting output. A timeline can coordinate many lighting changes over time.",
        action:
          "Open a sample from Timelines, press Play, and watch the Visualizer. Then press Stop. If your show has no timeline, skip this preview.",
        panels: ["Visualizer", "TimelinesPanel"],
        target: '[aria-label="Play timeline"], [aria-label="Pause timeline"]',
        hint: "Play a short section, then stop it.",
      },
      {
        id: "navigate",
        title: "Find your way around",
        body: "The Command Palette opens panels. Properties follows the active panel and selected object.",
        action:
          "Click Search, search for Open Fixtures, and press Enter. Open Properties the same way, then select a fixture.",
        panels: ["PropertiesInspector"],
        target: '[aria-label="Open command palette"]',
        hint: "Search for Open Fixtures.",
        more: "You can reopen closed panels here. Drag panel tabs to arrange your workspace; keep the Visualizer visible while learning.",
      },
      {
        id: "select",
        title: "Select lights by number",
        body: "Each fixture is a light with a numeric ID. The command line accepts short selection commands; > means an inclusive range.",
        action:
          "Enter fix 1>5 in the command input and press Enter. Look for the selected lights in Fixtures and the Visualizer. Use IDs from your patch if they differ.",
        panels: ["FixtureGrid", "Visualizer"],
        target: "#header-cmdline",
        hint: "Type fix 1>5 and press Enter.",
        observe: "selection",
      },
      {
        id: "look",
        title: "Build your first look",
        body: "The Programmer is your live workspace. Intensity controls brightness; color changes the look immediately.",
        action:
          "With your lights selected, enter @ 100. In Programmer, edit their color attributes to make a first look.",
        panels: ["ProgrammerGrid", "Visualizer"],
        target: "#header-cmdline",
        hint: "Set intensity with @ 100.",
        observe: "look",
        more: "RGB fixtures use red, green, and blue. For example, fix 1>5 red @ 100 green @ 0 blue @ 0 makes a red look on compatible fixtures. Fixture modes expose different attributes.",
      },
      {
        id: "sequence",
        title: "Give your looks a home",
        body: "A cue stores lighting instructions. A sequence puts cues in playback order.",
        action:
          "Open Sequences and add a new sequence. Give it a memorable label in Properties and note its ID. Use this new sequence for both cues.",
        panels: ["SequenceList", "PropertiesInspector"],
        target: '[aria-label="Add sequence"]',
        hint: "Create a sequence for your two looks.",
      },
      {
        id: "cue-one",
        title: "Store the first cue",
        body: "Storing captures the instructions you have built in the Programmer.",
        action:
          "In Programmer, choose Store cue. Enter your new sequence ID, cue ID 1, and a label for this look, then confirm Store Cue.",
        panels: ["ProgrammerGrid"],
        target: '[aria-label="Store cue"]',
        hint: "Store your first look here.",
        observe: "cue",
      },
      {
        id: "cue-two",
        title: "Make a second look",
        body: "A different color makes it easy to see the sequence advance.",
        action:
          "Change the color in Programmer. Store again into the same sequence as cue 2, with a different label.",
        panels: ["ProgrammerGrid"],
        target: '[aria-label="Store cue"]',
        hint: "Store the second look as cue 2.",
        observe: "cue",
      },
      {
        id: "manual",
        title: "Let Go control the timing",
        body: "Manual cues wait for you. Follow Previous cues advance automatically.",
        action:
          "Open your sequence from Sequences. Select cue 2 in its editor, then set Trigger to Manual in Properties.",
        panels: ["SequenceList", "PropertiesInspector"],
        more: "The first Go starts the sequence. Later presses advance it. You can explore fade times after the basic playback works.",
      },
      {
        id: "clear",
        title: "Release the Programmer",
        body: "Stored cues and live Programmer values are separate. Clear your live values to see what playback produces.",
        action:
          "Press Clear programmer until both the selection and programmed values are gone. The first press clears selection; the next clears values.",
        panels: ["ProgrammerGrid"],
        target: '[aria-label="Clear programmer"]',
        hint: "Clear selection, then clear values.",
        observe: "clear",
        more: "Setting intensity to zero leaves a live instruction. Clearing releases it, allowing other playback to control the fixture.",
      },
      {
        id: "clip",
        title: "Create a playback clip",
        body: "A clip connects a sequence or effect to playback controls.",
        action:
          "Add a clip in Clips. Select it and set its source to Sequence in Properties, then choose your new sequence.",
        panels: ["ClipList", "PropertiesInspector"],
        target: '[aria-label="Add clip"]',
        hint: "Add a clip for your sequence.",
      },
      {
        id: "assign",
        title: "Put the clip on a control",
        body: "Control slots give your clip a fader and a Go button.",
        action:
          "Drag your clip onto an empty Drop target in the Clips controls area. If controls are collapsed, expand that area first.",
        panels: ["ClipList"],
        target: "[data-clip-dropzone-index]",
        hint: "Drop your clip into an empty slot.",
      },
      {
        id: "go",
        title: "Play and advance",
        body: "Go starts your sequence. Pressing it again advances to the next cue.",
        action:
          "Raise your assigned fader and press its Go button. Press Go again to move to the second look and watch the color change.",
        panels: ["ClipList", "Visualizer"],
        target: "[data-control-go-index]:not(:disabled)",
        hint: "Press Go on your assigned control.",
      },
      {
        id: "fader",
        title: "Control the level",
        body: "The fader scales the clip’s intensity while preserving its programmed colors.",
        action:
          "Move your assigned fader down and up. Watch the lights dim and brighten, then stop the clip from its context menu or Status Display.",
        panels: ["ClipList", "Visualizer", "StatusDisplay"],
        target:
          '[data-guide="clip-control"] .noUi-target:not([disabled]) [role="slider"]',
        hint: "Drag this fader, or use its arrow keys.",
        more: "Lowering a fader is not the same as stopping playback. Stop your clip before starting another lesson.",
      },
    ],
  },
  {
    id: "patch",
    title: "Patching fixtures",
    duration: "5 min",
    introduction:
      "Tell Nightfall which lights you have and where their channels live.",
    prerequisite:
      "Use a practice show. Fixture-library import requires the real app; the demo can inspect its existing patch.",
    steps: [
      {
        id: "inspect",
        title: "Meet your patch",
        body: "A fixture definition describes the channels a light understands. Its mode determines which attributes and how many channels are available.",
        action:
          "Open Patch and inspect a fixture’s mode, universe, and start address.",
        panels: ["PatchEditor"],
      },
      {
        id: "add",
        title: "Add and address a fixture",
        body: "Read these steps before opening the wizard; return here after Finish. Match the fixture mode to your physical light. Each fixture needs an unused block of channels within a 512-channel DMX universe.",
        action:
          "Choose Add fixture. Select a definition and mode, inspect the channel preview, then set quantity and label. Leave Assign Console DMX enabled and choose an unused universe/address range. Review and Finish. In the demo, inspect an existing fixture instead.",
        panels: ["PatchEditor"],
        target: '[aria-label="Add fixture"]:not(:disabled)',
        hint: "Choose a definition and matching mode.",
      },
      {
        id: "address",
        title: "Check its channel range",
        body: "The finished fixture appears in Patch. Its mode determines how many consecutive channels it uses, beginning at its start address.",
        action:
          "Find the fixture you added, or an existing demo fixture. Check its universe and start address, and confirm its channel range does not overlap another fixture.",
        panels: ["PatchEditor"],
        more: "A console DMX address is internal to the show. The transports lesson explains how that universe reaches a physical output.",
      },
      {
        id: "verify",
        title: "Check your fixture",
        body: "The fixture’s ID is what you use in selection commands; it is separate from its DMX address.",
        action:
          "Find the fixture in Fixtures and note its ID. With physical output off, select it in the command line and inspect its attributes in Programmer.",
        panels: ["FixtureGrid", "ProgrammerGrid"],
        target: "#header-cmdline",
        hint: "Select the fixture using its numeric ID.",
      },
    ],
  },
  {
    id: "transports",
    title: "Transports and output",
    duration: "5 min",
    introduction: "Connect console universes to your lighting hardware.",
    prerequisite:
      "Take Patching first. Hardware setup requires the real app and your own interface or network; in the demo this is an inspection lesson.",
    steps: [
      {
        id: "routing",
        title: "From console to hardware",
        body: "Patching allocates console channels. A transport carries those values to a network or USB interface.",
        action:
          "Open I/O Transports. Inspect the available transport types and leave output off while configuring.",
        panels: ["IoTransports"],
      },
      {
        id: "configure",
        title: "Match your connection",
        body: "Network lighting uses Art-Net or sACN. USB output depends on a supported attached interface.",
        action:
          "In the real app, configure the available transport for your interface or network and map the console universe to the intended output universe. Match the receiver’s configuration.",
        panels: ["IoTransports"],
        more: "Use the settings for your own hardware. Universe numbering and network destinations must agree at both ends; the guide does not choose them for you.",
      },
      {
        id: "test",
        title: "Enable and test deliberately",
        body: "Enabling output sends your show’s values to real lights. The guide never enables it for you.",
        action:
          "When the rig is ready, enable the appropriate output yourself and test one fixture at a low intensity. Inspect Console DMX if needed. Turn output off again when your practice is finished.",
        panels: ["IoTransports", "DmxUniverse"],
        more: "In the demo, inspect console values only. Network and USB output are unavailable.",
      },
    ],
  },
  {
    id: "waveform",
    title: "Waveform effects",
    duration: "5 min",
    introduction:
      "Create continuous movement and spread it across your lights.",
    prerequisite:
      "Use a practice rig with intensity-capable fixtures. Clear Programmer values and stop other playback first.",
    steps: [
      {
        id: "open",
        title: "Open a waveform effect",
        body: "Waveform effects repeat a shape over time instead of storing every lighting change as a cue.",
        action:
          "In FX List, select a regular FX and choose Edit selected effect, or use Add effect → Regular FX.",
        panels: ["FxList"],
        target: '[aria-label="Add effect"]',
        hint: "Choose Regular FX, or edit an existing effect.",
      },
      {
        id: "shape",
        title: "Choose what changes",
        body: "The selection determines which fixtures participate. The attribute and range determine what the wave changes.",
        action:
          "Set the fixture selection to IDs in your rig and choose Intensity. Explore the waveform shape and its range in the editor.",
        panels: ["Visualizer"],
      },
      {
        id: "speed",
        title: "Try speed and spread",
        body: "Speed changes how fast the pattern repeats. Phase differences make fixtures reach different points of the pattern at the same time.",
        action:
          "Preview the effect. Adjust speed, then phase/spread, and compare the result in the Visualizer. Stop the preview when finished.",
        panels: ["Visualizer"],
      },
      {
        id: "play",
        title: "Give the effect a clip",
        body: "The same clip controls you used for sequences can play effects.",
        action:
          "Save the effect. Create a clip with an FX source, assign it to a free control, and use Go and the fader. Stop the clip before leaving.",
        panels: ["ClipList", "PropertiesInspector"],
        target: "[data-control-go-index]:not(:disabled)",
        hint: "Use Go on the effect’s assigned control.",
      },
    ],
  },
  {
    id: "step-fx",
    title: "Step FX designer",
    duration: "7 min",
    introduction: "Build a chase from explicit intensity steps.",
    prerequisite:
      "Use two or more intensity-capable fixtures in a practice show. Clear the Programmer and stop other playback first.",
    steps: [
      {
        id: "create",
        title: "Create a Step FX",
        body: "Step FX describes a repeating pattern as a series of values and durations.",
        action:
          "Open FX List and choose Add effect → Step FX. Give the effect a recognizable label.",
        panels: ["FxList"],
        target: '[aria-label="Add effect"]',
        hint: "Choose Step FX from this menu.",
      },
      {
        id: "selection",
        title: "Choose the participating lights",
        body: "The selection supplies the fixtures that will run through the pattern.",
        action:
          "Set Selection to fixture IDs in your rig, such as fix 1>5. Add or select the Intensity attribute lane.",
        target: '[aria-label="Step FX attributes"]',
        hint: "Work with an Intensity lane.",
      },
      {
        id: "steps",
        title: "Make an on/off pattern",
        body: "An absolute intensity track supplies brightness values directly. Two steps are enough for a simple chase.",
        action:
          "Use an absolute track. Set the first step to full intensity and the second to zero; add a step if needed. Give both equal widths.",
        target: '[aria-label="Add step"]',
        hint: "Add a second step, then edit the values.",
        more: "Step widths control each part’s duration. Relative contributions modify another value; start with absolute intensity so the result is easy to understand.",
      },
      {
        id: "spread",
        title: "Spread the pattern",
        body: "Different start positions let lights alternate instead of flashing together.",
        action:
          "Preview the effect and explore Start position / Spread. Watch how the selected fixtures move through the same steps at different points.",
        panels: ["Visualizer"],
        target: '[aria-label="Preview"], [aria-label="Stop preview"]',
        hint: "Preview the chase while changing spread.",
      },
      {
        id: "timing",
        title: "Shape the rhythm",
        body: "Speed changes the overall pace; step widths change the balance within a cycle.",
        action:
          "Adjust speed and compare equal versus unequal step widths. Stop preview, save the effect, and assign it to an FX clip to try its fader and Go. Stop playback when finished.",
        panels: ["ClipList", "PropertiesInspector"],
        target: '[aria-label="Step FX speed"]',
        hint: "Adjust the pace of the pattern.",
      },
    ],
  },
  {
    id: "timeline",
    title: "Timeline programming",
    duration: "5 min",
    introduction: "Arrange familiar playback actions along a clock.",
    prerequisite:
      "Use an existing practice timeline and a clip you can play. The demo provides a sample timeline; stop all other playback first.",
    steps: [
      {
        id: "open",
        title: "Explore the arrangement",
        body: "Tracks hold actions at specific times. Timeline playback triggers those actions as the playhead reaches them.",
        action:
          "Open a timeline from Timelines. Select an action and inspect it in Properties.",
        panels: ["TimelinesPanel", "PropertiesInspector"],
      },
      {
        id: "insert",
        title: "Schedule a clip",
        body: "An action can start the same clip you operated manually.",
        action:
          "Right-click a track, choose Insert Action, and select your clip and its playback action. Use a practice area of the timeline.",
        panels: ["ClipList"],
      },
      {
        id: "timing",
        title: "Place it in time",
        body: "Position determines when an action happens. The action’s available settings control its behavior and duration.",
        action:
          "Drag the action to a new time. Select it and inspect its timing in Properties; adjust its duration where supported.",
        panels: ["PropertiesInspector"],
      },
      {
        id: "rehearse",
        title: "Rehearse and stop",
        body: "The Visualizer lets you compare the arrangement with the resulting lights.",
        action:
          "Play the section and watch the result. Then press Stop timeline and check Status Display for any clips still running; stop those too.",
        panels: ["Visualizer", "StatusDisplay"],
        target: '[aria-label="Stop timeline"]',
        hint: "Stop the timeline after rehearsing.",
      },
    ],
  },
];
