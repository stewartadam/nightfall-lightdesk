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
import {
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  clearNotificationHistory,
  type NotificationHistoryEntry,
  notificationHistory,
  type ToastLevel,
} from "../../../state/appStores";
import {
  DialogBody,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../ui/dialog";
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
    <DialogSurface
      aria-label="Notification history"
      style={{ width: "min(38rem, calc(100vw - 0.75rem))" }}
      role="region"
    >
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
    </DialogSurface>
  );
}

/** Renders the header bell button and pop-out notification history. */
export default function HeaderNotificationHistory(): JSX.Element {
  const $notificationHistory = useStore(notificationHistory);
  const [isOpen, setIsOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;

  /** Keeps pop-out rows in reverse chronological order. */
  const rows = createMemo<NotificationHistoryEntry[]>(() =>
    [...$notificationHistory()].sort((a, b) => b.createdAt - a.createdAt),
  );

  /** Closes the pop-out when pointer interaction moves outside the header control. */
  const handleDocumentPointerDown = (event: PointerEvent) => {
    if (!rootRef?.contains(event.target as Node)) {
      setIsOpen(false);
    }
  };

  /** Closes the pop-out with Escape while preserving normal header focus behavior. */
  const handleDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setIsOpen(false);
    }
  };

  /** Installs outside-click and Escape dismissal while the header is mounted. */
  onMount(() => {
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
  });

  onCleanup(() => {
    document.removeEventListener("pointerdown", handleDocumentPointerDown);
    document.removeEventListener("keydown", handleDocumentKeyDown);
  });

  return (
    <div ref={rootRef} class="relative">
      <Tooltip content={() => "Notification history"} position="bottom">
        <Button
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

      <Show when={isOpen()}>
        <div
          class="absolute right-0 top-full z-[60] mt-2"
          role="dialog"
          aria-label="Notification history"
        >
          <NotificationHistoryContent rows={rows()} />
        </div>
      </Show>
    </div>
  );
}
