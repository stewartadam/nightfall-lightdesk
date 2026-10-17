// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { BellIcon } from "@squidlab/phosphor-solid/bell";
import { BellRingingIcon } from "@squidlab/phosphor-solid/bell-ringing";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import {
  clearNotificationHistory,
  type NotificationHistoryEntry,
  notificationHistory,
  type ToastLevel,
} from "../../../state/appStores";
import { runNotificationAction } from "../../../state/notifications";
import {
  DialogBody,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../ui/dialog";
import { Popover } from "../../ui/popover";
import { Table, TableEmptyRow, TableScroll } from "../../ui/table";
import Tooltip from "../../ui/tooltip";
import { Button } from "../../ui/visual-language/button";

/** Returns the badge classes used to visually distinguish notification severity. */
function levelClass(level: ToastLevel): string {
  switch (level) {
    case "success":
      return "bg-emerald-500/15 text-emerald-200 ring-emerald-400/30";
    case "warning":
      return "bg-amber-500/15 text-amber-100 ring-amber-400/30";
    case "error":
      return "bg-rose-500/15 text-rose-100 ring-rose-400/30";
    default:
      return "bg-sky-500/15 text-sky-100 ring-sky-400/30";
  }
}

/** Formats a notification severity for compact table display. */
function levelLabel(level: ToastLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/** Formats a timestamp with enough detail to disambiguate nearby notifications. */
function formatAbsoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Formats a timestamp as a short age label for quick scanning. */
function formatRelativeTime(timestamp: number): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - timestamp) / 1000),
  );
  if (elapsedSeconds < 5) return "now";
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
}

/** Renders the notification history rows inside the header pop-out. */
function NotificationHistoryContent(props: {
  rows: NotificationHistoryEntry[];
}): JSX.Element {
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <BellRingingIcon class="size-5 text-amber-300" aria-hidden />
          <span>Notification History</span>
        </DialogTitle>
        <Button
          size="icon"
          variant="danger"
          type="button"
          aria-label="Clear notification history"
          title="Clear notification history"
          disabled={props.rows.length === 0}
          onClick={clearNotificationHistory}
        >
          <TrashIcon class="size-4" aria-hidden />
        </Button>
      </DialogHeader>
      <DialogBody scrollable={false} class="flex flex-col">
        <TableScroll
          aria-label="Recent notifications"
          class="max-h-[min(26.5rem,calc(100vh-8.5rem))] border border-neutral-800"
        >
          <Table
            aria-label="Notification history"
            class="min-w-[520px] table-fixed text-left"
          >
            <thead>
              <tr>
                <th scope="col" class="w-24 text-center">
                  Severity
                </th>
                <th scope="col">Message</th>
                <th scope="col" class="w-40">
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              <Show
                when={props.rows.length > 0}
                fallback={
                  <TableEmptyRow colSpan={3}>
                    No notifications yet
                  </TableEmptyRow>
                }
              >
                <For each={props.rows}>
                  {(entry) => (
                    <tr>
                      <td class="text-center">
                        <span
                          class={`inline-flex justify-center rounded px-2 py-0.5 text-[11px] font-medium ring-1 ${levelClass(entry.level)}`}
                        >
                          {levelLabel(entry.level)}
                        </span>
                      </td>
                      <td>
                        <div class="whitespace-pre-wrap break-words leading-5">
                          {entry.message}
                        </div>
                        <Show when={entry.count > 1}>
                          <div class="mt-1 text-xs text-neutral-400">
                            Repeated {entry.count} times
                          </div>
                        </Show>
                        <Show when={entry.actions.length > 0}>
                          <div class="mt-2 flex flex-wrap gap-2">
                            <For each={entry.actions}>
                              {(action, index) => (
                                <Button
                                  size="compact"
                                  onClick={() =>
                                    runNotificationAction(entry.id, index())
                                  }
                                >
                                  {action.label}
                                </Button>
                              )}
                            </For>
                          </div>
                        </Show>
                      </td>
                      <td>
                        <div class="font-mono text-neutral-200">
                          {formatRelativeTime(entry.createdAt)}
                        </div>
                        <div
                          class="mt-1 whitespace-nowrap font-mono text-[11px] text-neutral-500"
                          title={new Date(entry.createdAt).toISOString()}
                        >
                          {formatAbsoluteTime(entry.createdAt)}
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </Show>
            </tbody>
          </Table>
        </TableScroll>
      </DialogBody>
    </>
  );
}

/** Renders the header bell button and pop-out notification history. */
export default function HeaderNotificationHistory(): JSX.Element {
  const $notificationHistory = useStore(notificationHistory);
  const [isOpen, setIsOpen] = createSignal(false);
  let anchorRef: HTMLDivElement | undefined;
  let bellRef: HTMLButtonElement | undefined;

  /** Keeps pop-out rows in reverse chronological order. */
  const rows = createMemo<NotificationHistoryEntry[]>(() =>
    [...$notificationHistory()].sort((a, b) => b.createdAt - a.createdAt),
  );

  return (
    <div ref={anchorRef} class="relative">
      <Tooltip content={() => "Notification history"} position="bottom">
        <Button
          ref={bellRef}
          size="icon"
          type="button"
          aria-label="Notification history"
          aria-expanded={isOpen()}
          aria-haspopup="dialog"
          onClick={() => setIsOpen((current) => !current)}
        >
          <BellIcon class="size-4" aria-hidden />
        </Button>
      </Tooltip>

      <Popover
        anchor={() => anchorRef}
        open={isOpen()}
        onClose={() => setIsOpen(false)}
        placement="below"
        align="end"
        initialFocus="none"
        returnFocus={() => bellRef}
        surface={DialogSurface}
        style={{ width: "min(38rem, calc(100vw - 0.75rem))" }}
        role="dialog"
        aria-label="Notification history"
      >
        <NotificationHistoryContent rows={rows()} />
      </Popover>
    </div>
  );
}
