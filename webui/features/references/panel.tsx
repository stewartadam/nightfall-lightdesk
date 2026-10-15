// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
} from "solid-js";
import {
  Checkbox,
  Input,
  NativeSelect,
} from "../../components/ui/form-controls";
import PanelToolbar from "../../components/ui/panel-toolbar";
import { SegmentedTabs } from "../../components/ui/segmented-tabs";
import { ToolbarButton } from "../../components/ui/toolbar-button";
import type { BasePanelComponentProps } from "../../lib/panel-registry";
import { referenceHealth, referenceList } from "../../state/appStores";
import {
  ReferenceHealthTable,
  ReferenceSummaryCell,
  ReferencesTable,
} from "./components/reference-tables";
import {
  DOMAIN_OPTIONS,
  filterReferenceIssues,
  filterReferences,
  type ReferenceDomainFilter,
  type ReferencePanelTab,
} from "./model/reference-panel-model";
import { pruneMissingFixtureReferences } from "./services/prune-references";
import { watchReferenceList } from "./services/reference-list-watch";

interface ReferencesPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

/**
 * Shows every reference in the show and the missing ones, as audited by the backend. The panel
 * asks for the full reference list while it is open; the health counts and issues reach every
 * client regardless.
 */
export default function ReferencesPanel(_props: ReferencesPanelProps) {
  const tabsId = createUniqueId();
  const contentId = `${tabsId}-content`;
  const $health = useStore(referenceHealth);
  const $references = useStore(referenceList);
  onCleanup(watchReferenceList());
  const [activeTab, setActiveTab] =
    createSignal<ReferencePanelTab>("references");
  const [domainFilter, setDomainFilter] =
    createSignal<ReferenceDomainFilter>("all");
  const [searchText, setSearchText] = createSignal("");
  const [missingOnly, setMissingOnly] = createSignal(false);

  /** Filters reference rows by toolbar controls. */
  const filteredReferences = createMemo(() =>
    filterReferences(
      $references(),
      domainFilter(),
      searchText(),
      missingOnly(),
    ),
  );

  /** Filters health rows by toolbar controls. */
  const filteredIssues = createMemo(() =>
    filterReferenceIssues($health().issues, domainFilter(), searchText()),
  );

  /** Counts visible rows that the prune command can repair. */
  const visiblePrunableCount = createMemo(
    () => filteredIssues().filter((issue) => issue.prunable).length,
  );

  /** Prunes every repairable missing fixture reference in the show, not only the visible ones. */
  const applyPrune = () =>
    void pruneMissingFixtureReferences($health().summary.prunable_issue_count);

  return (
    <div
      class="flex h-full min-h-0 flex-col bg-neutral-950 text-neutral-100"
      data-component="ReferencesPanel"
      data-panel-kind="references"
    >
      <PanelToolbar
        left={
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <SegmentedTabs
              id={tabsId}
              density="compact"
              contentId={contentId}
              label="Reference views"
              options={[
                { key: "references", label: "References" },
                { key: "health", label: "Health" },
              ]}
              value={activeTab()}
              onChange={setActiveTab}
            />
            <NativeSelect
              style={{ width: "auto" }}
              value={domainFilter()}
              onInput={(event) =>
                setDomainFilter(
                  event.currentTarget.value as ReferenceDomainFilter,
                )
              }
              aria-label="Reference domain"
            >
              <For each={DOMAIN_OPTIONS}>
                {(option) => (
                  <option value={option.value}>{option.label}</option>
                )}
              </For>
            </NativeSelect>
            <label class="flex items-center gap-1 text-sm text-neutral-300">
              <Checkbox
                checked={missingOnly()}
                onInput={(event) => setMissingOnly(event.currentTarget.checked)}
              />
              Missing
            </label>
          </div>
        }
        right={
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <Input
              style={{ width: "14rem", "max-width": "100%" }}
              value={searchText()}
              onInput={(event) => setSearchText(event.currentTarget.value)}
              placeholder="Filter"
              aria-label="Filter references"
            />
            <ToolbarButton
              label="Prune"
              tooltip="Prune missing resolved fixture refs"
              variant="danger"
              size="labeled"
              disabled={$health().summary.prunable_issue_count === 0}
              onClick={applyPrune}
            >
              <TrashIcon class="h-4 w-4" aria-hidden />
              Prune
            </ToolbarButton>
          </div>
        }
      />

      <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 border-b border-neutral-800 bg-neutral-950 p-2 text-sm">
        <ReferenceSummaryCell
          label="Objects"
          value={$health().summary.object_count}
        />
        <ReferenceSummaryCell
          label="References"
          value={$health().summary.reference_count}
        />
        <ReferenceSummaryCell
          label="Missing"
          value={$health().summary.issue_count}
        />
        <ReferenceSummaryCell
          label="Affected"
          value={$health().summary.affected_object_count}
        />
        <ReferenceSummaryCell label="Prunable" value={visiblePrunableCount()} />
      </div>

      <div
        class="min-h-0 min-w-0 flex-1"
        id={contentId}
        role="tabpanel"
        aria-labelledby={`${tabsId}-${activeTab()}`}
      >
        <Show
          when={activeTab() === "references"}
          fallback={<ReferenceHealthTable issues={filteredIssues()} />}
        >
          <ReferencesTable references={filteredReferences()} />
        </Show>
      </div>
    </div>
  );
}
