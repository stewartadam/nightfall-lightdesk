// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  Show,
  useContext,
} from "solid-js";
import { searchTerms, unmatchedSearchTerms } from "./search-match";

/**
 * One level of a settings search: the whole dialog, a category, a section, or a single entry.
 * Each level reports whether it is shown to the level above, so a heading disappears once
 * nothing beneath it matches.
 */
interface SettingsSearchScope {
  /** Whether a search is running at all. */
  searching: Accessor<boolean>;
  /**
   * Query words that no enclosing heading contains. Words a heading already matched need not
   * appear again beneath it, so "visualizer quality" finds the Quality row in the Visualizer tab,
   * and once none remain everything beneath is shown.
   */
  remaining: Accessor<string[]>;
  /** Adds a child's visibility to this level for as long as the child is mounted. */
  register: (visible: Accessor<boolean>) => void;
}

const SettingsSearchContext = createContext<SettingsSearchScope>();

/**
 * Holds the visibility of each child level mounted beneath a level. A child is added when it
 * registers and removed when its owner is disposed, such as when a tab's content unmounts.
 */
function createChildRegistry(): [
  Accessor<Accessor<boolean>[]>,
  SettingsSearchScope["register"],
] {
  const [children, setChildren] = createSignal<Accessor<boolean>[]>([]);
  /** Adds a child's visibility and removes it again when the calling owner is cleaned up. */
  const register = (child: Accessor<boolean>) => {
    setChildren((current) => [...current, child]);
    onCleanup(() =>
      setChildren((current) => current.filter((item) => item !== child)),
    );
  };
  return [children, register];
}

/**
 * Tracks whether a settings entry with no searchable children is shown: always outside a
 * search, otherwise when its own text, together with its headings, contains every query word.
 *
 * @param texts Text the entry is found by, such as a label, description, or keywords.
 */
export function useSettingsSearchEntry(
  texts: Accessor<readonly (string | undefined)[]>,
): Accessor<boolean> {
  const parent = useContext(SettingsSearchContext);
  if (!parent) return () => true;
  /** Whether no search is running or this entry covers every word its headings left. */
  const visible = createMemo(
    () =>
      !parent.searching() ||
      unmatchedSearchTerms(parent.remaining(), texts()).length === 0,
  );
  parent.register(visible);
  return visible;
}

/**
 * Tracks whether a settings heading, such as a category or section, is shown, and returns the
 * scope its entries search within. A heading is shown outside a search, when its text and the
 * headings above it contain every query word (which shows everything beneath it), or when any
 * entry beneath it is shown.
 *
 * @param texts Text the heading is found by, usually its title.
 */
export function useSettingsSearchHeading(
  texts: Accessor<readonly (string | undefined)[]>,
): { visible: Accessor<boolean>; scope?: SettingsSearchScope } {
  const parent = useContext(SettingsSearchContext);
  if (!parent) return { visible: () => true };
  /** Query words neither this heading nor any heading above it contains. */
  const remaining = createMemo(() =>
    unmatchedSearchTerms(parent.remaining(), texts()),
  );
  const [children, register] = createChildRegistry();
  /** Whether no search is running, this heading completes the match, or an entry beneath is shown. */
  const visible = createMemo(
    () =>
      !parent.searching() ||
      remaining().length === 0 ||
      children().some((child) => child()),
  );
  parent.register(visible);
  return {
    visible,
    scope: { searching: parent.searching, remaining, register },
  };
}

/** Makes a search level available to the settings entries rendered inside it. */
export function SettingsSearchProvider(props: {
  scope?: SettingsSearchScope;
  children: JSX.Element;
}) {
  return (
    <SettingsSearchContext.Provider value={props.scope}>
      {props.children}
    </SettingsSearchContext.Provider>
  );
}

/**
 * Starts a settings search over every `SettingsSection`, `SettingsRow`, and `SettingsSearchItem`
 * rendered inside it, hiding the ones that do not match `query`. `onResults` reports whether
 * anything matched, so the caller can show an empty state.
 */
export function SettingsSearchRoot(props: {
  query: string;
  children: JSX.Element;
  onResults?: (hasResults: boolean) => void;
}) {
  /** Lowercased words of the query; every one must be found for an entry to show. */
  const words = createMemo(() => searchTerms(props.query));
  const [children, register] = createChildRegistry();
  const scope: SettingsSearchScope = {
    searching: () => words().length > 0,
    remaining: words,
    register,
  };
  /** Reports whether any top-level entry is still shown for the current query. */
  createEffect(() => props.onResults?.(children().some((child) => child())));
  return (
    <SettingsSearchContext.Provider value={scope}>
      {props.children}
    </SettingsSearchContext.Provider>
  );
}

/**
 * Wraps settings content that is not a `SettingsRow`, such as a picker or an explanation, so a
 * search shows it only when `keywords` match or an enclosing heading does.
 */
export function SettingsSearchItem(props: {
  keywords: string;
  class?: string;
  children: JSX.Element;
}) {
  const visible = useSettingsSearchEntry(() => [props.keywords]);
  return (
    <div class={props.class} hidden={!visible()}>
      {props.children}
    </div>
  );
}

/**
 * Groups settings under a heading for search, such as a dialog category. Without a search the
 * heading is left out and only the children render. When nothing inside matches, the whole
 * group hides; when the heading matches, everything inside shows.
 */
export function SettingsSearchGroup(props: {
  title: string;
  /** Shows the title as a heading above the group, for search results spanning categories. */
  showTitle?: boolean;
  class?: string;
  style?: JSX.CSSProperties;
  children: JSX.Element;
}) {
  const { visible, scope } = useSettingsSearchHeading(() => [props.title]);
  return (
    <div class={props.class} style={props.style} hidden={!visible()}>
      <Show when={props.showTitle}>
        <h2 class="text-xs font-semibold uppercase tracking-wide text-gray-400">
          {props.title}
        </h2>
      </Show>
      <SettingsSearchProvider scope={scope}>
        {props.children}
      </SettingsSearchProvider>
    </div>
  );
}
