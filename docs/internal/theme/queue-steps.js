// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Turns a `div.queue-steps` step list into a step-through animation of a message queue.
 *
 * The page writes the process as an ordered list, which GitHub and readers without JavaScript see
 * as plain numbered steps. The container's `data-frames` attribute maps each frame id to a label
 * and a message class (`nd`, `snap`, or `delta`). Each list item describes one step:
 *
 * - `data-queue`: the frame ids in the queue, front first.
 * - `data-incoming`: a frame the engine is publishing, drawn above the queue.
 * - `data-flash`: frames to highlight in this step.
 * - `data-delivered`: frames the client has received, oldest first.
 *
 * The script draws the client, the queue, and one chip per frame, then moves the chips between
 * positions as the reader steps forward and back. The list item's text becomes the caption.
 */
(() => {
  const SLOT_START = 150;
  const SLOT_STEP = 128;
  const INCOMING_TOP = 22;
  const QUEUE_TOP = 108;
  const PLAY_INTERVAL_MS = 2400;
  const CLASS_NAMES = {
    nd: "Non-droppable",
    snap: "Droppable snapshot",
    delta: "Delta",
  };

  /** Splits a space-separated list of frame ids from a step attribute. */
  const ids = (item, name) =>
    (item.getAttribute(name) ?? "").split(/\s+/).filter(Boolean);

  /** Returns a new element with a class name and optional text. */
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };

  /** Builds the widget for one container and replaces its step list with it. */
  const build = (container) => {
    const list = container.querySelector("ol");
    if (!list) return;
    let frames;
    try {
      frames = JSON.parse(container.dataset.frames ?? "{}");
    } catch {
      return;
    }
    const steps = Array.from(list.children).map((item) => ({
      queue: ids(item, "data-queue"),
      incoming: ids(item, "data-incoming"),
      flash: ids(item, "data-flash"),
      delivered: ids(item, "data-delivered"),
      caption: item,
    }));
    if (steps.length === 0) return;

    const widget = element("div", "queue-steps-widget");
    const scroller = element("div", "queue-steps-scroller");
    const stage = element("div", "queue-steps-stage");
    stage.setAttribute("aria-hidden", "true");
    stage.append(
      element("div", "queue-steps-client"),
      element("div", "queue-steps-tag queue-steps-client-tag", "Client"),
      element("div", "queue-steps-lane"),
      element(
        "div",
        "queue-steps-tag queue-steps-lane-tag",
        container.dataset.laneLabel ?? "Queue, front on the left",
      ),
      element(
        "div",
        "queue-steps-tag queue-steps-source-tag",
        "Engine publishes",
      ),
    );
    scroller.append(stage);

    const legend = element("div", "queue-steps-legend");
    const kinds = new Set(Object.values(frames).map(([, kind]) => kind));
    for (const kind of Object.keys(CLASS_NAMES).filter((k) => kinds.has(k))) {
      const entry = element(
        "span",
        `queue-steps-kind-${kind}`,
        CLASS_NAMES[kind],
      );
      legend.append(entry);
    }

    const chips = new Map();
    for (const [id, [label, kind]] of Object.entries(frames)) {
      const chip = element(
        "div",
        `queue-steps-frame queue-steps-kind-${kind} gone`,
        label,
      );
      chip.style.left = `${SLOT_START + 3 * SLOT_STEP}px`;
      chip.style.top = `${INCOMING_TOP}px`;
      stage.append(chip);
      chips.set(id, chip);
    }

    const caption = element("div", "queue-steps-caption");
    caption.setAttribute("aria-live", "polite");
    const controls = element("div", "queue-steps-controls");
    const back = element("button", "", "Back");
    const next = element("button", "", "Next step");
    const play = element("button", "", "Play");
    const reset = element("button", "", "Reset");
    const count = element("span", "queue-steps-count");
    for (const button of [back, next, play, reset]) button.type = "button";
    controls.append(back, next, play, reset, count);
    widget.append(legend, scroller, caption, controls);

    let current = 0;
    let timer = null;

    /** Places every chip for the current step and updates the caption and buttons. */
    const render = () => {
      const step = steps[current];
      for (const [id, chip] of chips) {
        const queued = step.queue.indexOf(id);
        const incoming = step.incoming.indexOf(id);
        const delivered = step.delivered.indexOf(id);
        let visible = true;
        if (queued >= 0) {
          chip.style.left = `${SLOT_START + queued * SLOT_STEP}px`;
          chip.style.top = `${QUEUE_TOP}px`;
        } else if (incoming >= 0) {
          chip.style.left = `${SLOT_START + (incoming + 1) * SLOT_STEP}px`;
          chip.style.top = `${INCOMING_TOP}px`;
        } else if (delivered >= 0) {
          chip.style.left = "0px";
          chip.style.top = `${QUEUE_TOP}px`;
          visible = delivered === step.delivered.length - 1;
        } else {
          visible = false;
        }
        chip.classList.toggle("gone", !visible);
        chip.classList.toggle("flash", step.flash.includes(id));
      }
      caption.replaceChildren(...step.caption.cloneNode(true).childNodes);
      count.textContent = `Step ${current + 1} of ${steps.length}`;
      back.disabled = current === 0;
      next.disabled = current === steps.length - 1;
    };

    /** Moves to a step, clamped to the list. */
    const go = (index) => {
      current = Math.max(0, Math.min(steps.length - 1, index));
      render();
    };

    /** Stops automatic playback and restores the Play label. */
    const stop = () => {
      clearInterval(timer);
      timer = null;
      play.textContent = "Play";
    };

    next.addEventListener("click", () => {
      stop();
      go(current + 1);
    });
    back.addEventListener("click", () => {
      stop();
      go(current - 1);
    });
    reset.addEventListener("click", () => {
      stop();
      go(0);
    });
    play.addEventListener("click", () => {
      if (timer) {
        stop();
        return;
      }
      if (current === steps.length - 1) go(0);
      play.textContent = "Pause";
      timer = setInterval(() => {
        if (current === steps.length - 1) stop();
        else go(current + 1);
      }, PLAY_INTERVAL_MS);
    });

    list.hidden = true;
    container.append(widget);
    render();
  };

  document.querySelectorAll("main div.queue-steps").forEach(build);
})();
