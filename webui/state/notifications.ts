// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import Toastify from "toastify-js";
import { type AppIcon, renderIconComponent } from "../components/ui/icon";
import { TOAST_DURATION_MS } from "../lib/constants";
import { setStoreAction } from "../lib/nanostore-action";
import {
  createNotificationQueue,
  type NotificationEntry,
  type NotificationHandle,
  type ToastAction,
  type ToastLevel,
} from "../lib/notification-queue";

export type { ToastAction, ToastLevel } from "../lib/notification-queue";
export type NotificationHistoryEntry = NotificationEntry;
export interface ToastPresentation {
  title?: string;
  icon?: AppIcon;
}

export const notificationHistory = atom<NotificationHistoryEntry[]>([]);
const notifications = createNotificationQueue({
  render: renderToast,
  publishHistory: (entries) =>
    setStoreAction(notificationHistory, "Update Notification History", entries),
  schedule: (flush) => setTimeout(flush, 50),
});

/** Removes current and pending history entries without hiding visible notifications. */
export function clearNotificationHistory(): void {
  notifications.clearHistory();
}

/** Runs the shared action from either a visible toast or retained notification history. */
export function runNotificationAction(id: number, index: number): void {
  notifications.runAction(id, index);
}

/** Queues typed feedback without synchronously creating DOM or publishing store updates. */
export function pushToast(
  level: ToastLevel,
  message: string,
  ttlMs = TOAST_DURATION_MS,
  actions: readonly ToastAction[] = [],
  presentation: ToastPresentation = {},
): void {
  notifications.push({ level, message, ttlMs, actions, ...presentation });
}

const toastStyles: Record<
  ToastLevel,
  { iconBg: string; iconColor: string; icon: string }
> = {
  info: {
    iconBg: "bg-blue-100 dark:bg-blue-800/30",
    iconColor: "text-blue-500",
    icon: "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  success: {
    iconBg: "bg-teal-100 dark:bg-teal-800/30",
    iconColor: "text-teal-500",
    icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  warning: {
    iconBg: "bg-yellow-100 dark:bg-yellow-800/30",
    iconColor: "text-yellow-500",
    icon: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
  },
  error: {
    iconBg: "bg-red-100 dark:bg-red-800/30",
    iconColor: "text-red-500",
    icon: "M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z",
  },
};

/** Builds the custom Toastify DOM node for a typed toast message. */
function createToastNode(
  level: ToastLevel,
  message: string,
  presentation: ToastPresentation,
): HTMLElement {
  const style = toastStyles[level];
  const container = document.createElement("div");
  container.dataset.component = "Toast";
  container.dataset.level = level;
  container.className =
    "max-w-xs bg-white border border-gray-200 rounded-xl shadow-lg dark:bg-neutral-800 dark:border-neutral-700";
  container.setAttribute("role", "alert");

  container.innerHTML = `
    <div class="toast-layout flex p-4">
      <div class="shrink-0">
        <span class="toast-icon inline-flex items-center justify-center size-8 rounded-full ${style.iconBg}" aria-hidden="true">
          <svg class="shrink-0 size-4 ${style.iconColor}" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="${style.icon}" />
          </svg>
        </span>
      </div>
      <div class="toast-content ms-3 me-2 grow min-w-0">
        ${presentation.title ? `<div class="toast-title mb-1 text-sm font-semibold text-gray-900 dark:text-neutral-100">${escapeHtml(presentation.title)}</div>` : ""}
        <p class="text-sm text-gray-700 dark:text-neutral-400">${escapeHtml(message)}</p>
      </div>
      <button type="button" class="toast-close inline-flex shrink-0 justify-center items-center size-5 rounded-lg text-gray-800 opacity-50 hover:opacity-100 focus:outline-hidden focus:opacity-100 dark:text-white" aria-label="Close">
        <span class="sr-only">Close</span>
        <svg class="shrink-0 size-4" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  `;

  return container;
}

/** Escapes untrusted text before inserting it into toast HTML. */
function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/** Renders one admitted notification and releases its slot only after Toastify removes it. */
function renderToast(
  entry: NotificationEntry,
  onDismiss: () => void,
  onClosing: () => void,
): NotificationHandle {
  const node = createToastNode(entry.level, entry.message, {
    title: entry.title,
  });
  const iconHost = node.querySelector<HTMLElement>(".toast-icon");
  if (iconHost && entry.icon)
    renderIconComponent(iconHost, entry.icon as AppIcon, "size-5 shrink-0");
  const count = document.createElement("span");
  count.className = "toast-count block text-xs font-medium mt-1";
  node.querySelector(".toast-content")?.append(count);
  const message = node.querySelector("p")!;
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const toast = Toastify({
    node,
    duration: -1,
    gravity: "top",
    position: "right",
    className: "!bg-transparent !shadow-none !p-0",
    offset: { x: 16, y: 16 },
    /** Disposes Solid icon roots and makes the physical toast slot available. */
    callback: () => {
      if (iconHost && entry.icon) renderIconComponent(iconHost, undefined, "");
      onDismiss();
    },
  });
  /** Starts dismissal once, keeping the slot occupied throughout the exit transition. */
  function dismiss() {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    onClosing();
    for (const button of node.querySelectorAll("button"))
      button.disabled = true;
    toast.hideToast();
  }
  /** Restarts automatic dismissal after hover or focus leaves a nonpersistent notification. */
  function armTimer() {
    clearTimeout(timer);
    if (
      entry.ttlMs > 0 &&
      !closing &&
      !node.matches(":hover") &&
      !node.contains(document.activeElement)
    )
      timer = setTimeout(dismiss, entry.ttlMs);
  }
  node.addEventListener("mouseenter", () => clearTimeout(timer));
  node.addEventListener("mouseleave", armTimer);
  node.addEventListener("focusin", () => clearTimeout(timer));
  node.addEventListener("focusout", () => setTimeout(armTimer, 0));
  node.querySelector(".toast-close")?.addEventListener("click", dismiss);
  if (entry.actions.length > 0) {
    const actionBar = document.createElement("div");
    actionBar.className = "toast-actions mt-3 flex flex-wrap gap-2";
    entry.actions.forEach((action, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "toast-action rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-800 hover:bg-gray-100 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-700";
      button.textContent = action.label;
      button.addEventListener("click", () =>
        runNotificationAction(entry.id, index),
      );
      actionBar.append(button);
    });
    node.querySelector(".toast-content")?.append(actionBar);
  }
  /** Updates counted feedback and realigns the bounded stack if its height changes. */
  function update(current: NotificationEntry) {
    message.textContent = current.message;
    count.textContent =
      current.title !== "Notification summary" && current.count > 1
        ? `Repeated ${current.count} times`
        : "";
    node.dataset.level = current.level;
    if (!current.icon && iconHost) {
      const style = toastStyles[current.level];
      iconHost.className = `toast-icon inline-flex items-center justify-center size-8 rounded-full ${style.iconBg}`;
      iconHost
        .querySelector("svg")
        ?.setAttribute("class", `shrink-0 size-4 ${style.iconColor}`);
      iconHost.querySelector("path")?.setAttribute("d", style.icon);
    }
    if (node.isConnected) Toastify.reposition();
  }
  update(entry);
  toast.showToast();
  armTimer();
  return { update, dismiss };
}
