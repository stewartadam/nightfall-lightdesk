// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { children, createUniqueId, type JSX, Show } from "solid-js";
import "./settings-row.css";
import { renderedText } from "./search-match";
import {
  SettingsSearchProvider,
  useSettingsSearchEntry,
  useSettingsSearchHeading,
} from "./settings-search";

/** Typography of a row title, one step quieter than a section heading. */
const LABEL_CLASS = "text-sm font-medium text-gray-300";

/** Ids a settings row hands its control so the row's title and description label it. */
export interface SettingsRowField {
  /** Id for the control, which the row's title labels. */
  id: string;
  /** Id of the row's description, present only when the row has one. */
  describedBy?: string;
}

interface SettingsRowProps {
  /** Title of the setting, shown on the left and used as the control's label. */
  label: string;
  /** Explanation beneath the title, announced as the control's description. */
  description?: JSX.Element;
  /**
   * Renders the title as an `<h3>`, for rows that open a section of
   * their own, such as a sharing choice followed by what it sends.
   */
  heading?: boolean;
  /**
   * Whether the title is a `<label>` for the control. Turn it off when the control is a button
   * whose own text names it, since a label would replace that name.
   */
  labelControl?: boolean;
  /** Content running full width beneath the title and control, such as a list or an error. */
  details?: JSX.Element;
  /** Extra words a settings search finds this row by, beyond its title and description. */
  keywords?: string;
  class?: string;
  "data-testid"?: string;
  /** Renders the control, given the ids that tie it to the row's title and description. */
  children: (field: SettingsRowField) => JSX.Element;
}

/**
 * Lays out one setting as a row: title and description on the left, the control aligned to the
 * right edge, and optional details full width beneath. The control wraps beneath the text when
 * the row is too narrow for both. Place rows in a `SettingsSection` to divide them.
 */
export function SettingsRow(props: SettingsRowProps) {
  const id = createUniqueId();
  const descriptionId = `${id}-description`;
  /** The description resolved once, so reading it for both rendering and `describedBy` does not rebuild it. */
  const description = children(() => props.description);
  const visible = useSettingsSearchEntry(() => [
    props.label,
    renderedText(description()),
    props.keywords,
  ]);
  /** Title element: a label for the control unless the row opts out. */
  const title = () =>
    props.labelControl === false ? (
      <span class={LABEL_CLASS}>{props.label}</span>
    ) : (
      <label for={id} class={LABEL_CLASS}>
        {props.label}
      </label>
    );
  return (
    <div
      class={`nf-settings-row ${props.class ?? ""}`}
      data-testid={props["data-testid"]}
      hidden={!visible()}
    >
      <div class="nf-settings-row-text">
        <Show when={props.heading} fallback={title()}>
          <h3>{title()}</h3>
        </Show>
        <Show when={description()}>
          <div id={descriptionId} class="text-xs leading-[1.45] text-gray-400">
            {description()}
          </div>
        </Show>
      </div>
      <div class="nf-settings-row-control">
        {props.children({
          id,
          get describedBy() {
            return description() ? descriptionId : undefined;
          },
        })}
      </div>
      <Show when={props.details}>
        {(details) => <div class="nf-settings-row-details">{details()}</div>}
      </Show>
    </div>
  );
}

/**
 * Groups related settings rows under an optional heading, which also names the section. A titled
 * section draws a rule from its title to the edge and indents its rows beneath it. Each
 * direct child is divided from the next by a thin line, so a row wrapped in a labelled region
 * divides like a bare row; `footer` adds a note beneath the last one. In a settings search, the
 * section hides when none of its rows match, and shows them all when its title matches.
 */
export function SettingsSection(props: {
  title?: string;
  footer?: JSX.Element;
  class?: string;
  children: JSX.Element;
}) {
  const titleId = createUniqueId();
  const { visible, scope } = useSettingsSearchHeading(() => [props.title]);
  return (
    <section
      class={`nf-settings-section ${props.class ?? ""}`}
      aria-labelledby={props.title ? titleId : undefined}
      hidden={!visible()}
    >
      <Show when={props.title}>
        {(title) => (
          <h3 id={titleId} class="nf-settings-section-title">
            {title()}
          </h3>
        )}
      </Show>
      <div class="nf-settings-rows">
        <SettingsSearchProvider scope={scope}>
          {props.children}
        </SettingsSearchProvider>
      </div>
      <Show when={props.footer}>
        {(footer) => (
          <div class="pt-2 text-xs leading-[1.45] text-gray-400">
            {footer()}
          </div>
        )}
      </Show>
    </section>
  );
}
