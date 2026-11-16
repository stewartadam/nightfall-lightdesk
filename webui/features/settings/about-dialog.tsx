// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { CopyIcon } from "@squidlab/phosphor-solid/copy";
import { FolderOpenIcon } from "@squidlab/phosphor-solid/folder-open";
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { useAppShell } from "../../components/providers/app-shell";
import { Badge } from "../../components/ui/badge";
import { Dialog, DialogBody } from "../../components/ui/dialog";
import { SegmentedTabs } from "../../components/ui/segmented-tabs";
import Tooltip from "../../components/ui/tooltip";
import { Button } from "../../components/ui/visual-language/button";
import {
  APP_BUILD_ID,
  APP_BUILD_NAME,
  APP_COPYRIGHT,
  APP_LICENSE,
  APP_NAME,
  APP_VERSION,
} from "../../lib/app-metadata";
import { writeClipboardText } from "../../lib/clipboard";
import { getLogger } from "../../lib/logger";
import {
  getNightfallDataDirectoryPath,
  isTauriRuntime,
  openDataDirectory,
} from "../../lib/tauri";
import { pushToast, serverVersion } from "../../state/appStores";
import { AboutUpdateStatus, createAboutUpdates } from "./about-updates";
import ThirdPartyNotices from "./third-party-notices";

const log = getLogger(import.meta.url);

/** Tabs of the About dialog. */
type AboutTab = "info" | "updates" | "notices";

/** Id of the element that holds the selected tab's content. */
const ABOUT_TAB_PANEL_ID = "about-tab-panel";

const INFO_TAB = { key: "info", label: "Info" } as const;
const UPDATES_TAB = { key: "updates", label: "Updates" } as const;
const NOTICES_TAB = { key: "notices", label: "Third-Party Notices" } as const;

/**
 * Presents the app name and license above tabs for build metadata and data-directory actions,
 * desktop update status and controls, and bundled licenses. The Updates tab only exists in the
 * desktop app, and carries a badge while a newer version is available.
 */
export function AboutDialog() {
  const { isAboutOpen, closeAbout } = useAppShell();
  const connectedVersion = useStore(serverVersion);
  const updates = createAboutUpdates();
  const [isOpeningDataDirectory, setIsOpeningDataDirectory] =
    createSignal(false);
  const [tab, setTab] = createSignal<AboutTab>("info");
  const [noticesLoaded, setNoticesLoaded] = createSignal(false);

  /** Whether the desktop app reports an update status, which is what the Updates tab shows. */
  const hasUpdates = createMemo(() => !!updates.update());

  /** Whether a newer version has been found, from the offer through its install. */
  const updateAvailable = createMemo(() => {
    const phase = updates.update()?.phase;
    return !!phase && phase !== "idle" && phase !== "checking";
  });

  /**
   * Tabs to offer, rebuilt only when the Updates tab or its badge comes or goes, so focus stays
   * on its tab while the update status changes.
   */
  const tabs = createMemo(() => {
    if (!hasUpdates()) return [INFO_TAB, NOTICES_TAB];
    const updatesTab = updateAvailable()
      ? {
          key: "updates" as const,
          label: (
            <span class="inline-flex items-center gap-1.5">
              Updates
              <span class="sr-only">, update available</span>
              <Badge
                tone="info"
                appearance="solid"
                size="sm"
                mono
                aria-hidden="true"
              >
                1
              </Badge>
            </span>
          ),
        }
      : UPDATES_TAB;
    return [INFO_TAB, updatesTab, NOTICES_TAB];
  });

  /** Opens the dialog on Info each time, and forgets the notices so they reload when next opened. */
  createEffect(
    on(isAboutOpen, () => {
      setNoticesLoaded(false);
      setTab("info");
    }),
  );

  /** Leaves the Updates tab when the desktop app stops reporting an update status. */
  createEffect(() => {
    if (tab() === "updates" && !hasUpdates()) setTab("info");
  });

  /** Keeps the notices loaded once opened, so switching tabs keeps their search and expanded entries. */
  createEffect(() => {
    if (tab() === "notices") setNoticesLoaded(true);
  });

  /** Prefers the connected engine version and falls back to the bundled UI version. */
  const displayedVersion = () => connectedVersion() || APP_VERSION;
  const showOpenDataDirectory = isTauriRuntime();

  /** Describes the available directory action and its pending state. */
  const dataDirectoryActionLabel = () =>
    showOpenDataDirectory
      ? isOpeningDataDirectory()
        ? "Opening..."
        : "Open"
      : "Copy Path";

  /** Resolves the directory tooltip, including environments without a local path. */
  const dataDirectoryPath = () => {
    try {
      return getNightfallDataDirectoryPath();
    } catch {
      return "Unable to determine nightfall data directory path";
    }
  };

  /** Opens the native data directory and reports the outcome without duplicate requests. */
  const handleOpenDataDirectory = async () => {
    if (isOpeningDataDirectory()) {
      return;
    }

    setIsOpeningDataDirectory(true);
    try {
      await openDataDirectory();
      pushToast("success", "Opened nightfall data directory");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast("error", `Failed to open data directory: ${message}`);
      log.error("Failed to open data directory:", { error });
    } finally {
      setIsOpeningDataDirectory(false);
    }
  };

  /** Copies the data directory path and reports clipboard failures. */
  const handleCopyDataDirectoryPath = async () => {
    try {
      await writeClipboardText(getNightfallDataDirectoryPath());
      pushToast("success", "Copied nightfall data directory path");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast("error", `Failed to copy data directory path: ${message}`);
      log.error("Failed to copy data directory path:", { error });
    }
  };

  return (
    <Dialog
      kind="info"
      isOpen={isAboutOpen()}
      title="About"
      label={`About ${APP_NAME}`}
      closeLabel="Close about dialog"
      onDismiss={closeAbout}
      class="max-w-[600px]"
    >
      <div class="shrink-0 space-y-4 px-4 pt-4">
        <div class="flex items-center gap-4">
          <img
            src={`${import.meta.env.BASE_URL}logo.svg`}
            alt={`${APP_NAME} logo`}
            class="size-18 rounded-xl border border-gray-700 bg-[#0B1020] p-2 shadow-inner"
          />
          <div class="min-w-0">
            <h3 class="text-xl font-semibold text-gray-50">{APP_NAME}</h3>
            <p class="text-sm text-gray-400">
              Lighting control and visualization
            </p>
            <p class="text-sm text-gray-400">
              <span innerHTML={APP_COPYRIGHT}></span>, licensed under{" "}
              {APP_LICENSE}.
            </p>
          </div>
        </div>
        <SegmentedTabs
          id="about-tabs"
          label="About sections"
          contentId={ABOUT_TAB_PANEL_ID}
          options={tabs()}
          value={tab()}
          onChange={setTab}
        />
      </div>
      <DialogBody
        id={ABOUT_TAB_PANEL_ID}
        role="tabpanel"
        aria-labelledby={`about-tabs-${tab()}`}
      >
        <Switch>
          <Match when={tab() === "info"}>
            <div class="space-y-5">
              <div class="grid gap-3 rounded-lg border border-gray-700 bg-gray-900/60 p-4 text-sm">
                <div class="flex items-center justify-between gap-3">
                  <span class="text-gray-400">Version</span>
                  <div class="flex items-center gap-3">
                    <span class="font-mono text-gray-100">
                      {displayedVersion()}
                    </span>
                  </div>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-gray-400">Build ID</span>
                  <span class="font-mono text-gray-100">{APP_BUILD_ID}</span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-gray-400">Build Name</span>
                  <span
                    data-testid="build-name"
                    class="min-w-0 truncate font-mono text-gray-100"
                  >
                    {APP_BUILD_NAME}
                  </span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-gray-400">Data directory</span>
                  <span
                    data-testid="data-directory"
                    class="min-w-0 truncate font-mono text-gray-100"
                  >
                    <div class="flex justify-end">
                      <Tooltip
                        position="top"
                        content={() => (
                          <span class="block max-w-[min(28rem,calc(100vw-2rem))] whitespace-normal break-all text-left font-mono">
                            {dataDirectoryPath()}
                          </span>
                        )}
                      >
                        <Button
                          size="compact"
                          type="button"
                          class="items-center gap-2"
                          disabled={
                            showOpenDataDirectory && isOpeningDataDirectory()
                          }
                          onClick={() =>
                            void (showOpenDataDirectory
                              ? handleOpenDataDirectory()
                              : handleCopyDataDirectoryPath())
                          }
                        >
                          <Dynamic
                            component={
                              showOpenDataDirectory ? FolderOpenIcon : CopyIcon
                            }
                            class="size-4"
                            aria-hidden
                          />
                          <span>{dataDirectoryActionLabel()}</span>
                        </Button>
                      </Tooltip>
                    </div>
                  </span>
                </div>
              </div>
            </div>
          </Match>
          <Match when={tab() === "updates"}>
            <AboutUpdateStatus updates={updates} />
          </Match>
        </Switch>
        <Show when={noticesLoaded()}>
          <div hidden={tab() !== "notices"}>
            <ThirdPartyNotices />
          </div>
        </Show>
      </DialogBody>
    </Dialog>
  );
}
