// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Renders ```mermaid code blocks as diagrams.
 *
 * mdBook emits these blocks as `code.language-mermaid`. This script loads a pinned Mermaid build
 * only on pages that contain one, replaces each block with a diagram container, and renders it
 * with a theme that matches the active mdBook theme. When the book theme changes, the diagrams
 * render again from their saved source, and each container's `data-rendered` attribute names the
 * Mermaid theme of its finished diagram. Without network access the blocks stay readable as text.
 */
(() => {
  const MERMAID_URL =
    "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs";
  const DARK_THEMES = ["coal", "navy", "ayu"];

  const blocks = Array.from(document.querySelectorAll("code.language-mermaid"));
  if (blocks.length === 0) return;

  /** Replaces each code block's `<pre>` with a container that keeps the diagram source. */
  const containers = blocks.map((code) => {
    const container = document.createElement("div");
    container.className = "mermaid-diagram";
    container.dataset.source = code.textContent ?? "";
    container.textContent = container.dataset.source;
    container.style.whiteSpace = "pre";
    container.style.fontFamily = "var(--mono-font, monospace)";
    code.parentElement?.replaceWith(container);
    return container;
  });

  /** Returns the Mermaid theme that matches the current mdBook theme class on `<html>`. */
  const mermaidTheme = () => {
    const classes = document.documentElement.classList;
    return DARK_THEMES.some((theme) => classes.contains(theme))
      ? "dark"
      : "default";
  };

  import(MERMAID_URL)
    .then(({ default: mermaid }) => {
      let renderedTheme = "";
      let pending = Promise.resolve();

      /**
       * Renders every diagram from its saved source when the theme differs from the last render.
       * A diagram with a syntax error renders as Mermaid's error diagram instead of throwing, so
       * authors see the error and the docs spec can detect it.
       */
      const render = async () => {
        const theme = mermaidTheme();
        if (theme === renderedTheme) return;
        renderedTheme = theme;
        mermaid.initialize({
          startOnLoad: false,
          theme,
          securityLevel: "strict",
        });
        for (const container of containers) {
          container.removeAttribute("data-processed");
          delete container.dataset.rendered;
          container.textContent = container.dataset.source ?? "";
        }
        await mermaid.run({ nodes: containers, suppressErrors: true });
        for (const container of containers) {
          container.style.whiteSpace = "";
          container.style.fontFamily = "";
          container.dataset.rendered = theme;
        }
      };

      /**
       * Queues a render after any render still in progress, so a theme change during a render
       * cannot reset containers that Mermaid is still filling. A failed render is retried on the
       * next theme change.
       */
      const scheduleRender = () => {
        pending = pending.then(render).catch(() => {
          renderedTheme = "";
        });
      };

      scheduleRender();
      new MutationObserver(scheduleRender).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
    })
    .catch(() => {
      // Leave the diagram source visible as text when Mermaid cannot load.
    });
})();
