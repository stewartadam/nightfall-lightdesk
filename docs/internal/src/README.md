# Nightfall Developer Guide

{{#include includes/human-review-disclaimer.md}}

This guide explains how Nightfall works inside, for people who want to understand, change, or extend it.

**Note:** This guide assumes you already know how to operate Nightfall as a lighting console: patching fixtures, programming cues, and running playbacks. If you don't, work through the [user manual](../index.html) first, starting with its [Your first show](../user-guide/getting-started.html) tutorial, which builds the show this guide uses as its running example.

[CONTRIBUTING.md](https://github.com/stewartadam/nightfall-lightdesk/blob/develop/CONTRIBUTING.md) covers how to set up a development environment, run the app, and run the tests.

## How the guide is organized

The guide moves from ideas to implementation. Each part uses only the terms that earlier parts introduce, so you can stop reading at the depth you need:

1. **How Nightfall works** describes what happens between "I programmed a show" and "light comes out," without code. Start here even if you plan to work on the web UI.
1. **How it's built** describes the processes, crates, and web UI that implement those ideas, and how they talk to each other.
1. **Engine internals** describes how the engine runs a frame and how a command changes state, in terms of Bevy schedules and systems.
1. **Domain deep dives** cover one subsystem each, such as cues and sequences, the programmer, or the 3D visualizer.
1. **Working on Nightfall** covers conventions, testing, CI, and releases.

Several parts are still being written. The [writing style](contributing/writing-style.md) page describes how to add to the guide.

## A running example

Pages in the first parts follow one small show, built in the user manual's [Your first show](../user-guide/getting-started.html) tutorial:

- One fixture, `Practice light`, with intensity, red, green, and blue channels, patched at console universe 1, address 1.
- A sequence, `First sequence`, with two cues: `Red` and `Blue`.
- A clip, `First playback`, that plays `First sequence`.

When a page explains a mechanism, it shows what that mechanism does to this show.
