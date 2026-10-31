// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { IconProvider } from "@squidlab/phosphor-solid";
import { ArrowSquareOutIcon } from "@squidlab/phosphor-solid/arrow-square-out";
import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { DatabaseIcon } from "@squidlab/phosphor-solid/database";
import { DotsThreeIcon } from "@squidlab/phosphor-solid/dots-three";
import { FileTextIcon } from "@squidlab/phosphor-solid/file-text";
import { FolderOpenIcon } from "@squidlab/phosphor-solid/folder-open";
import { RepeatIcon } from "@squidlab/phosphor-solid/repeat";
import { SignInIcon } from "@squidlab/phosphor-solid/sign-in";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import { TerminalWindowIcon } from "@squidlab/phosphor-solid/terminal-window";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import type { JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Dynamic, Portal, render } from "solid-js/web";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./components/ui/dropdown-menu";
import type { AppIcon } from "./components/ui/icon";
import { Table, TableScroll } from "./components/ui/table";
import { writeClipboardText } from "./lib/clipboard";
import { TOAST_DURATION_MS } from "./lib/constants";
import { getLogger } from "./lib/logger";
import { pushToast } from "./state/appStores";

import "./index.css";

type ServiceName =
  | "backend"
  | "ui"
  | "docs-user"
  | "docs-dev"
  | "artnet-sender"
  | "sacn-sender";
type ServiceTarget = ServiceName | "wasm" | "both" | "senders";
type ServiceAction = "start" | "stop" | "recycle";
type DashboardAction =
  | ServiceAction
  | "open-editor"
  | "open-log"
  | "reseed-data-dir"
  | "remove";
interface RunActionOptions {
  sampleData?: boolean;
}

interface ManagedServiceState {
  pid: number | null;
  running: boolean;
  startedAt: string | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastError: string | null;
  logPath: string | null;
}

interface WorktreeSummary {
  id: string;
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  isMain: boolean;
  /** False for the primary worktree and the checkout running the dashboard. */
  canRemove: boolean;
  envPath: string;
  envExists: boolean;
  nightfallPort: number | null;
  webUiPort: number | null;
  webUiUrl: string | null;
  docsUserPort: number | null;
  docsUserUrl: string | null;
  docsDevPort: number | null;
  docsDevUrl: string | null;
  managed: Record<ServiceName, ManagedServiceState>;
  observed: {
    backendPortOpen: boolean;
    webUiPortOpen: boolean;
    docsUserPortOpen: boolean;
    docsDevPortOpen: boolean;
    backendPid: number | null;
    webUiPid: number | null;
    docsUserPid: number | null;
    docsDevPid: number | null;
    artnetSenderRunning: boolean;
    sacnSenderRunning: boolean;
  };
}

interface DashboardStatePayload {
  generatedAt: string;
  dashboardPid: number;
  worktrees: WorktreeSummary[];
}

/** Body of a refused or failed worktree removal. */
interface RemoveWorktreeResponse {
  ok: boolean;
  reason?: "local-changes" | "unmerged" | "failed";
  message: string;
  /** The first few changed files or unmerged commits. */
  details: string[];
  /** How many changed files or unmerged commits there are in all. */
  total: number;
}

interface ActionMenuItem {
  action: ServiceAction;
  icon: AppIcon;
  title: string;
}

interface ServiceTargetGroup {
  key: string;
  options: Array<{ value: ServiceTarget; label: string }>;
}

interface StatusDotProps {
  isReachable: boolean;
  isManagedRunning: boolean;
  status: string;
  children?: JSX.Element;
}

type ActionMenuPlacement = "up" | "down";

const EMPTY_MANAGED_SERVICE_STATE: ManagedServiceState = {
  pid: null,
  running: false,
  startedAt: null,
  lastExitCode: null,
  lastExitSignal: null,
  lastError: null,
  logPath: null,
};

const EMPTY_DASHBOARD_PAYLOAD: DashboardStatePayload = {
  generatedAt: "",
  dashboardPid: 0,
  worktrees: [],
};

const API_BASE_PATH = "/worktree-api";
const POLL_INTERVAL_MS = 2000;
const log = getLogger(import.meta.url);
const ACTION_MENU_OFFSET_PX = 4;
const ACTION_MENU_VIEWPORT_PADDING_PX = 8;
const ACTION_MENU_Z_INDEX = "2147483647";
const REFUSAL_TOAST_MS = TOAST_DURATION_MS * 3;
const REFUSAL_DETAILS_SHOWN = 3;
const WORKTREE_SERVICE_OPTIONS: Array<{ value: ServiceTarget; label: string }> =
  [
    { value: "backend", label: "Backend" },
    { value: "ui", label: "Web UI" },
  ];

const DOCS_SERVICE_GROUP: ServiceTargetGroup = {
  key: "docs-services",
  options: [
    { value: "docs-user", label: "User docs" },
    { value: "docs-dev", label: "Developer docs" },
  ],
};

const WORKTREE_SERVICE_OPTIONS_WITH_WASM: Array<{
  value: ServiceTarget;
  label: string;
}> = [...WORKTREE_SERVICE_OPTIONS, { value: "wasm", label: "Wasm" }];

const SENDER_SERVICE_GROUP: ServiceTargetGroup = {
  key: "sender-services",
  options: [
    { value: "artnet-sender", label: "Art-Net Sender" },
    { value: "sacn-sender", label: "sACN Sender" },
  ],
};

function serviceTargetGroupsForAction(
  action: ServiceAction,
  senderActionsSupported: boolean,
): ServiceTargetGroup[] {
  const groups: ServiceTargetGroup[] = [
    {
      key: "worktree-services",
      options:
        action === "start" || action === "recycle"
          ? WORKTREE_SERVICE_OPTIONS_WITH_WASM
          : WORKTREE_SERVICE_OPTIONS,
    },
    DOCS_SERVICE_GROUP,
  ];
  if (senderActionsSupported) {
    groups.push(SENDER_SERVICE_GROUP);
  }
  return groups;
}

function hasSenderSupportInPayload(payload: DashboardStatePayload): boolean {
  return (payload.worktrees ?? []).some((worktree) => {
    const managed = (worktree as { managed?: Record<string, unknown> }).managed;
    if (!managed) return false;
    return "artnet-sender" in managed || "sacn-sender" in managed;
  });
}
const ACTION_MENU_ITEMS: ActionMenuItem[] = [
  {
    action: "recycle",
    icon: RepeatIcon,
    title: "Recycle",
  },
  { action: "stop", icon: StopIcon, title: "Stop" },
];

function statusOrbClasses(
  isReachable: boolean,
  isManagedRunning: boolean,
): string {
  if (isReachable) {
    return "bg-emerald-500";
  }
  if (isManagedRunning) {
    return "bg-amber-500 animate-pulse";
  }
  return "bg-rose-500";
}

function serviceStatusText(
  isReachable: boolean,
  isManagedRunning: boolean,
  pid: number | null,
): string {
  if (!isReachable && isManagedRunning) {
    if (pid !== null) {
      return `managed (starting..., ${pid})`;
    }
    return "managed (starting...)";
  }

  if (isManagedRunning) {
    return pid !== null ? `managed (${pid})` : "managed";
  }

  const status = !isReachable ? "offline" : "unmanaged";

  if (pid !== null) {
    return `${status} (${pid})`;
  }

  return status;
}

function StatusDot(props: StatusDotProps) {
  return (
    <span class="group relative inline-flex items-center gap-2">
      <span
        class={`size-2.5 rounded-full ${statusOrbClasses(props.isReachable, props.isManagedRunning)}`}
      />
      {props.children}
      <span class="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] text-white shadow-lg group-hover:block dark:bg-slate-700">
        {props.status}
      </span>
    </span>
  );
}

interface ServiceLogButtonProps {
  /** Service name as shown in the tooltip and accessible label. */
  label: string;
  logPath: string | null;
  /** Last start error, shown instead of the log path so failures are visible on hover. */
  lastError?: string | null;
  pending: boolean;
  onOpen: () => void;
}

/**
 * Opens a managed service's log file in the editor; disabled until the
 * dashboard has started the service once and while an open is in flight.
 */
function ServiceLogButton(props: ServiceLogButtonProps) {
  return (
    <button
      type="button"
      class="inline-flex items-center justify-center rounded-md border border-slate-300 p-1 text-slate-600 hover:border-slate-400 hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-100"
      title={
        props.lastError ??
        (props.logPath
          ? `Open ${props.label} log: ${props.logPath}`
          : `No ${props.label} log file yet`)
      }
      aria-label={`Open ${props.label} log file`}
      disabled={!props.logPath || props.pending}
      onClick={() => props.onOpen()}
    >
      <FileTextIcon class="size-3.5" aria-hidden />
    </button>
  );
}

interface BookServiceRowProps {
  /** Book name as shown in tooltips and accessible labels. */
  label: string;
  port: number | null;
  url: string | null;
  isReachable: boolean;
  managed: ManagedServiceState;
  /** Listener PID found on the book's port, used when the dashboard did not start it. */
  observedPid: number | null;
  logPending: boolean;
  onOpenLog: () => void;
}

/**
 * Renders one line of the Docs column: an mdBook server's status, port, and
 * log button, plus a link that opens the book once its port answers. The
 * status tooltip names the book so stacked rows stay distinguishable.
 */
function BookServiceRow(props: BookServiceRowProps) {
  return (
    <div class="flex items-center gap-2">
      <StatusDot
        isReachable={props.isReachable}
        isManagedRunning={props.managed.running}
        status={`${props.label}: ${serviceStatusText(
          props.isReachable,
          props.managed.running,
          props.managed.pid ?? props.observedPid,
        )}`}
      >
        <p class="font-mono text-xs text-slate-600 dark:text-slate-300">
          {props.port ?? "n/a"}
        </p>
      </StatusDot>
      <ServiceLogButton
        label={props.label}
        logPath={props.managed.logPath}
        lastError={props.managed.lastError}
        pending={props.logPending}
        onOpen={props.onOpenLog}
      />
      <Show when={props.isReachable && props.url}>
        {(url) => (
          <a
            href={url()}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${props.label}`}
            aria-label={`Open ${props.label}`}
            class="inline-flex items-center p-1 text-sky-700 hover:text-sky-800 dark:text-sky-300 dark:hover:text-sky-200"
          >
            <ArrowSquareOutIcon
              class="size-3 text-sky-700 dark:text-sky-300"
              aria-hidden
            />
          </a>
        )}
      </Show>
    </div>
  );
}

function actionKey(
  worktreeId: string,
  action: DashboardAction,
  service: ServiceTarget,
): string {
  return `${worktreeId}:${action}:${service}`;
}

function actionLabel(action: ServiceAction): string {
  if (action === "start") return "started";
  if (action === "stop") return "stopped";
  return "recycled";
}

function serviceLabel(service: ServiceTarget): string {
  if (service === "both") return "both";
  if (service === "senders") return "both senders";
  if (service === "ui") return "web ui";
  if (service === "docs-user") return "user docs";
  if (service === "docs-dev") return "developer docs";
  if (service === "wasm") return "wasm";
  if (service === "artnet-sender") return "art-net sender";
  if (service === "sacn-sender") return "sacn sender";
  return "backend";
}

/**
 * Explains why a worktree was kept and how to remove it anyway: uncommitted
 * files are named, and an unmerged branch reports its commit count and the
 * reason `wt done` gave.
 */
function removalRefusalMessage(
  label: string,
  response: RemoveWorktreeResponse,
): string {
  const forceHint = "Hold Shift and choose Force delete to remove it anyway.";
  const { total } = response;
  if (response.reason === "local-changes") {
    const files = response.details.slice(0, REFUSAL_DETAILS_SHOWN);
    const more = total > files.length ? ", …" : "";
    return `${label} has ${response.message} (${files.join(", ")}${more}). ${forceHint}`;
  }
  const unmerged =
    total > 0
      ? `has ${total} unmerged ${total === 1 ? "commit" : "commits"}`
      : "isn't merged";
  return `${label} ${unmerged} (${response.message}). ${forceHint}`;
}

function normalizeManagedServiceState(
  input: Partial<ManagedServiceState> | null | undefined,
): ManagedServiceState {
  if (!input) return { ...EMPTY_MANAGED_SERVICE_STATE };
  return {
    pid: input.pid ?? null,
    running: Boolean(input.running),
    startedAt: input.startedAt ?? null,
    lastExitCode: input.lastExitCode ?? null,
    lastExitSignal: input.lastExitSignal ?? null,
    lastError: input.lastError ?? null,
    logPath: input.logPath ?? null,
  };
}

function normalizeDashboardPayload(
  payload: DashboardStatePayload,
): DashboardStatePayload {
  return {
    ...payload,
    worktrees: (payload.worktrees ?? []).map((worktree) => {
      const managed = (worktree.managed ?? {}) as Partial<
        Record<ServiceName, Partial<ManagedServiceState>>
      >;
      const observed = (worktree.observed ?? {}) as Partial<
        WorktreeSummary["observed"]
      >;

      return {
        ...worktree,
        canRemove: Boolean(worktree.canRemove),
        docsUserPort: worktree.docsUserPort ?? null,
        docsUserUrl: worktree.docsUserUrl ?? null,
        docsDevPort: worktree.docsDevPort ?? null,
        docsDevUrl: worktree.docsDevUrl ?? null,
        managed: {
          backend: normalizeManagedServiceState(managed.backend),
          ui: normalizeManagedServiceState(managed.ui),
          "docs-user": normalizeManagedServiceState(managed["docs-user"]),
          "docs-dev": normalizeManagedServiceState(managed["docs-dev"]),
          "artnet-sender": normalizeManagedServiceState(
            managed["artnet-sender"],
          ),
          "sacn-sender": normalizeManagedServiceState(managed["sacn-sender"]),
        },
        observed: {
          backendPortOpen: Boolean(observed.backendPortOpen),
          webUiPortOpen: Boolean(observed.webUiPortOpen),
          backendPid:
            typeof observed.backendPid === "number"
              ? observed.backendPid
              : null,
          webUiPid:
            typeof observed.webUiPid === "number" ? observed.webUiPid : null,
          docsUserPortOpen: Boolean(observed.docsUserPortOpen),
          docsUserPid:
            typeof observed.docsUserPid === "number"
              ? observed.docsUserPid
              : null,
          docsDevPortOpen: Boolean(observed.docsDevPortOpen),
          docsDevPid:
            typeof observed.docsDevPid === "number"
              ? observed.docsDevPid
              : null,
          artnetSenderRunning: Boolean(observed.artnetSenderRunning),
          sacnSenderRunning: Boolean(observed.sacnSenderRunning),
        },
      };
    }),
  };
}

function WorktreeDashboardApp() {
  const [payload, setPayload] = createStore<DashboardStatePayload>({
    ...EMPTY_DASHBOARD_PAYLOAD,
  });
  const [hasPayload, setHasPayload] = createSignal(false);
  const [senderActionsSupported, setSenderActionsSupported] =
    createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [pendingActions, setPendingActions] = createSignal<Set<string>>(
    new Set(),
  );
  const [copiedPathFor, setCopiedPathFor] = createSignal<string | null>(null);
  const [shiftHeld, setShiftHeld] = createSignal(false);
  const [openActionMenu, setOpenActionMenu] = createSignal<string | null>(null);
  const [actionMenuPlacement, setActionMenuPlacement] =
    createSignal<ActionMenuPlacement>("down");
  const [actionMenuStyle, setActionMenuStyle] = createSignal<JSX.CSSProperties>(
    {
      position: "fixed",
      left: "-9999px",
      top: "-9999px",
      "z-index": ACTION_MENU_Z_INDEX,
    },
  );
  const [openActionMenuAnchor, setOpenActionMenuAnchor] =
    createSignal<HTMLButtonElement | null>(null);
  let openActionMenuPanel: HTMLDivElement | undefined;

  const worktrees = createMemo(() => payload.worktrees);
  /** Worktrees with per-worktree configuration can be managed by the dashboard services. */
  const initializedWorktrees = createMemo(() =>
    worktrees().filter((worktree) => worktree.envExists),
  );
  /** Worktrees missing .env are visible for orientation but grouped after managed entries. */
  const uninitializedWorktrees = createMemo(() =>
    worktrees().filter((worktree) => !worktree.envExists),
  );
  const metadataText = createMemo(() => {
    if (!hasPayload()) {
      return "Waiting for dashboard state...";
    }
    return `Updated ${new Date(payload.generatedAt).toLocaleTimeString()} | API PID ${payload.dashboardPid} | ${payload.worktrees.length} Worktrees`;
  });

  function worktreeLabel(worktreeId: string): string {
    const current = worktrees().find((worktree) => worktree.id === worktreeId);
    if (!current) return worktreeId;
    return current.branch ?? current.name;
  }

  function actionMenuKey(worktreeId: string, action: ServiceAction): string {
    return `${worktreeId}:${action}`;
  }

  function isActionPending(worktreeId: string, action: ServiceAction): boolean {
    const prefix = `${actionMenuKey(worktreeId, action)}:`;
    for (const key of pendingActions()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  function disableActionWhilePending(action: ServiceAction): boolean {
    return action === "stop";
  }

  function isPendingOperation(key: string): boolean {
    return pendingActions().has(key);
  }

  function hasPendingOperationForWorktree(worktreeId: string): boolean {
    const prefix = `${worktreeId}:`;
    for (const key of pendingActions()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  function markPendingOperation(key: string): void {
    setPendingActions((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }

  function clearPendingOperation(key: string): void {
    setPendingActions((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function openActionMenuFor(
    worktreeId: string,
    action: ServiceAction,
    anchor: HTMLButtonElement,
  ): void {
    const key = actionMenuKey(worktreeId, action);
    if (openActionMenu() === key) {
      setOpenActionMenu(null);
      setOpenActionMenuAnchor(null);
      return;
    }
    setOpenActionMenuAnchor(anchor);
    setOpenActionMenu(key);
  }

  async function runActionFromMenu(
    worktreeId: string,
    action: ServiceAction,
    service: ServiceTarget,
    options: RunActionOptions = {},
  ): Promise<void> {
    await runAction(worktreeId, action, service, options);
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  function positionOpenActionMenu(): void {
    const anchor = openActionMenuAnchor();
    if (!anchor || !openActionMenuPanel) return;

    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = openActionMenuPanel.getBoundingClientRect();
    const panelWidth = panelRect.width;
    const panelHeight = panelRect.height;

    const maxLeft = Math.max(
      ACTION_MENU_VIEWPORT_PADDING_PX,
      window.innerWidth - panelWidth - ACTION_MENU_VIEWPORT_PADDING_PX,
    );
    const left = clamp(
      anchorRect.left,
      ACTION_MENU_VIEWPORT_PADDING_PX,
      maxLeft,
    );

    const availableBelow =
      window.innerHeight -
      anchorRect.bottom -
      ACTION_MENU_OFFSET_PX -
      ACTION_MENU_VIEWPORT_PADDING_PX;
    const shouldOpenUp =
      panelHeight > availableBelow &&
      anchorRect.top -
        ACTION_MENU_OFFSET_PX -
        ACTION_MENU_VIEWPORT_PADDING_PX >=
        panelHeight;

    let top = shouldOpenUp
      ? anchorRect.top - panelHeight - ACTION_MENU_OFFSET_PX
      : anchorRect.bottom + ACTION_MENU_OFFSET_PX;
    const maxTop = Math.max(
      ACTION_MENU_VIEWPORT_PADDING_PX,
      window.innerHeight - panelHeight - ACTION_MENU_VIEWPORT_PADDING_PX,
    );
    top = clamp(top, ACTION_MENU_VIEWPORT_PADDING_PX, maxTop);

    setActionMenuPlacement(shouldOpenUp ? "up" : "down");
    setActionMenuStyle({
      position: "fixed",
      left: `${left}px`,
      top: `${top}px`,
      "min-width": `${anchorRect.width}px`,
      "z-index": ACTION_MENU_Z_INDEX,
    });
  }

  createEffect(() => {
    const openMenuKey = openActionMenu();
    const anchor = openActionMenuAnchor();
    if (!openMenuKey || !anchor) return;

    setActionMenuStyle({
      position: "fixed",
      left: "-9999px",
      top: "-9999px",
      "z-index": ACTION_MENU_Z_INDEX,
    });
    requestAnimationFrame(() => positionOpenActionMenu());

    const handleViewportChange = () => positionOpenActionMenu();
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);

    onCleanup(() => {
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    });
  });

  createEffect(() => {
    worktrees();
    queueMicrotask(() => {
      window.HSStaticMethods?.autoInit();
    });
  });

  async function refresh(options: { silent?: boolean } = {}): Promise<void> {
    if (!options.silent) {
      setLoading(true);
    }

    try {
      const response = await fetch(`${API_BASE_PATH}/worktrees`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Failed to load worktrees (${response.status})`);
      }

      const next = normalizeDashboardPayload(
        (await response.json()) as DashboardStatePayload,
      );
      setSenderActionsSupported(hasSenderSupportInPayload(next));
      setPayload("generatedAt", next.generatedAt);
      setPayload("dashboardPid", next.dashboardPid);
      setPayload(
        "worktrees",
        reconcile(next.worktrees, { key: "id", merge: true }),
      );
      setHasPayload(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.silent) {
        pushToast("error", `Failed to refresh worktree dashboard: ${message}`);
      }
      log.error("Failed to refresh worktree dashboard state:", error);
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  }

  async function runAction(
    worktreeId: string,
    action: ServiceAction,
    service: ServiceTarget = "backend",
    options: RunActionOptions = {},
  ): Promise<void> {
    const key = actionKey(worktreeId, action, service);
    markPendingOperation(key);

    try {
      const params = new URLSearchParams({
        service,
      });
      if (options.sampleData) {
        params.set("sample-data", "1");
      }
      const response = await fetch(
        `${API_BASE_PATH}/worktrees/${encodeURIComponent(worktreeId)}/${action}?${params.toString()}`,
        { method: "POST" },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Request failed (${response.status})`);
      }

      await refresh({ silent: true });
      pushToast(
        "success",
        `${actionLabel(action)} ${serviceLabel(service)} for ${worktreeLabel(worktreeId)}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast(
        "error",
        `Failed to ${action} ${serviceLabel(service)} for ${worktreeLabel(worktreeId)}: ${message}`,
      );
      log.error("Failed to execute dashboard action:", {
        error,
        action,
        service,
        worktreeId,
      });
    } finally {
      clearPendingOperation(key);
    }
  }

  async function openEditor(worktreeId: string): Promise<void> {
    const key = actionKey(worktreeId, "open-editor", "both");
    markPendingOperation(key);

    try {
      const response = await fetch(
        `${API_BASE_PATH}/worktrees/${encodeURIComponent(worktreeId)}/open-editor`,
        { method: "POST" },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Request failed (${response.status})`);
      }

      pushToast("success", `Opened ${worktreeLabel(worktreeId)} in VS Code`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast(
        "error",
        `Failed to open ${worktreeLabel(worktreeId)} in VS Code: ${message}`,
      );
      log.error("Failed to open worktree in editor:", {
        error,
        worktreeId,
      });
    } finally {
      clearPendingOperation(key);
    }
  }

  /** Re-runs the Worktrunk data-directory seed hook for a secondary worktree. */
  async function reseedDataDirectory(worktreeId: string): Promise<void> {
    const key = actionKey(worktreeId, "reseed-data-dir", "both");
    markPendingOperation(key);

    try {
      const response = await fetch(
        `${API_BASE_PATH}/worktrees/${encodeURIComponent(worktreeId)}/reseed-data-dir`,
        { method: "POST" },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Request failed (${response.status})`);
      }

      pushToast(
        "success",
        `Re-seeded the data directory for ${worktreeLabel(worktreeId)}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast(
        "error",
        `Failed to re-seed the data directory for ${worktreeLabel(worktreeId)}: ${message}`,
      );
      log.error("Failed to re-seed worktree data directory:", {
        error,
        worktreeId,
      });
    } finally {
      clearPendingOperation(key);
    }
  }

  /**
   * Removes a worktree and, when merged, its branch. The dashboard refuses a
   * worktree with local changes or an unmerged branch and the toast says which;
   * `force` removes it anyway and deletes the branch.
   */
  async function deleteWorktree(
    worktreeId: string,
    force: boolean,
  ): Promise<void> {
    const key = actionKey(worktreeId, "remove", "both");
    const label = worktreeLabel(worktreeId);
    markPendingOperation(key);

    try {
      const response = await fetch(
        `${API_BASE_PATH}/worktrees/${encodeURIComponent(worktreeId)}/remove${force ? "?force=1" : ""}`,
        { method: "POST" },
      );

      if (response.status === 409) {
        const refusal = (await response.json()) as RemoveWorktreeResponse;
        if (refusal.reason !== "failed") {
          pushToast(
            "warning",
            removalRefusalMessage(label, refusal),
            REFUSAL_TOAST_MS,
            [],
            { title: `Kept ${label}` },
          );
          return;
        }
        throw new Error(refusal.message);
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Request failed (${response.status})`);
      }

      pushToast("success", `Deleted ${label}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast("error", `Failed to delete ${label}: ${message}`);
      log.error("Failed to delete worktree:", { error, worktreeId, force });
    } finally {
      clearPendingOperation(key);
      // A failed removal may still have deleted the worktree.
      await refresh({ silent: true });
    }
  }

  /**
   * Collects the less frequent per-worktree actions behind a "..." button.
   * Delete turns into Force delete while Shift is held.
   */
  function WorktreeOverflowMenu(props: {
    worktree: WorktreeSummary;
    showReseed: boolean;
  }) {
    const pending = (action: DashboardAction) =>
      isPendingOperation(actionKey(props.worktree.id, action, "both"));
    return (
      <DropdownMenu
        trigger={<DotsThreeIcon class="size-4" weight="bold" aria-hidden />}
        triggerLabel="More actions"
        triggerTitle="More actions"
        triggerClass="inline-flex items-center justify-center px-2.5 py-1.5 text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-200 dark:hover:bg-slate-700"
        contentLabel={`Actions for ${props.worktree.branch ?? props.worktree.name}`}
        placement="below"
        align="end"
      >
        <Show when={props.showReseed}>
          <DropdownMenuItem
            icon={DatabaseIcon}
            description={
              props.worktree.isMain
                ? "Main worktree is the data seed source"
                : undefined
            }
            disabled={props.worktree.isMain || pending("reseed-data-dir")}
            onClick={() => void reseedDataDirectory(props.worktree.id)}
          >
            Re-seed data from main
          </DropdownMenuItem>
        </Show>
        <DropdownMenuItem
          icon={TerminalWindowIcon}
          disabled={pending("open-editor")}
          onClick={() => void openEditor(props.worktree.id)}
        >
          Open in VS Code
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={TrashIcon}
          danger
          description={
            !props.worktree.canRemove
              ? "The primary worktree can't be deleted"
              : shiftHeld()
                ? "Discards local changes and unmerged commits"
                : "Hold Shift to force"
          }
          disabled={!props.worktree.canRemove || pending("remove")}
          onClick={(event) =>
            void deleteWorktree(props.worktree.id, event.shiftKey)
          }
        >
          {shiftHeld() ? "Force delete" : "Delete"}
        </DropdownMenuItem>
      </DropdownMenu>
    );
  }

  async function openServiceLog(
    worktreeId: string,
    service: ServiceName,
  ): Promise<void> {
    const key = actionKey(worktreeId, "open-log", service);
    markPendingOperation(key);

    try {
      const response = await fetch(
        `${API_BASE_PATH}/worktrees/${encodeURIComponent(worktreeId)}/open-log?service=${encodeURIComponent(service)}`,
        { method: "POST" },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Request failed (${response.status})`);
      }

      pushToast(
        "success",
        `Opened ${service} log for ${worktreeLabel(worktreeId)}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast(
        "error",
        `Failed to open ${service} log for ${worktreeLabel(worktreeId)}: ${message}`,
      );
      log.error("Failed to open service log:", {
        error,
        worktreeId,
        service,
      });
    } finally {
      clearPendingOperation(key);
    }
  }

  async function copyWorktreePath(worktree: WorktreeSummary): Promise<void> {
    try {
      await writeClipboardText(worktree.path);
      setCopiedPathFor(worktree.id);
      window.setTimeout(() => {
        setCopiedPathFor((current) =>
          current === worktree.id ? null : current,
        );
      }, 1400);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast("error", `Could not copy path: ${message}`);
      log.error("Failed to copy worktree path:", error);
    }
  }

  onMount(() => {
    void refresh();

    const pollTimer = window.setInterval(() => {
      void refresh({ silent: true });
    }, POLL_INTERVAL_MS);

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest("[data-action-menu]")) {
        return;
      }
      setOpenActionMenu(null);
      setOpenActionMenuAnchor(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);

    /** Mirrors the Shift key so the overflow menu can relabel Delete as Force delete. */
    const handleModifierChange = (event: KeyboardEvent) =>
      setShiftHeld(event.shiftKey);
    /** Clears Shift when the window loses focus and its keyup would be missed. */
    const handleBlur = () => setShiftHeld(false);
    window.addEventListener("keydown", handleModifierChange);
    window.addEventListener("keyup", handleModifierChange);
    window.addEventListener("blur", handleBlur);

    onCleanup(() => {
      window.clearInterval(pollTimer);
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleModifierChange);
      window.removeEventListener("keyup", handleModifierChange);
      window.removeEventListener("blur", handleBlur);
    });
  });

  return (
    <div class="mx-auto max-w-[1280px] p-4 text-slate-900 md:p-6 dark:text-slate-100">
      <header class="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:flex md:items-start md:justify-between dark:border-slate-700 dark:bg-slate-900">
        <div>
          <div class="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-sky-700 dark:border-sky-800 dark:bg-sky-900/30 dark:text-sky-300">
            <TerminalWindowIcon
              class="size-3 text-sky-700 dark:text-sky-300"
              aria-hidden
            />
            Worktree Launcher
          </div>
          <h1 class="mt-2 text-xl font-semibold text-slate-900 md:text-2xl dark:text-slate-100">
            nightfall multi-worktree dashboard
          </h1>
          <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {metadataText()}
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-600 dark:text-slate-300">
            <span class="inline-flex items-center gap-1.5">
              <span class="size-2.5 rounded-full bg-emerald-500" />
              Online
            </span>
            <span class="inline-flex items-center gap-1.5">
              <span class="size-2.5 rounded-full bg-rose-500" />
              Offline
            </span>
          </div>
        </div>
        <div class="mt-3 flex items-center gap-2 md:mt-0">
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-slate-500 dark:hover:bg-slate-700"
            onClick={() => void refresh()}
            disabled={loading()}
          >
            <ArrowsClockwiseIcon class="size-4 text-slate-500" aria-hidden />
            Refresh
          </button>
          <a
            href="/"
            class="inline-flex items-center gap-2 rounded-lg border border-slate-900 bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 dark:border-slate-500 dark:bg-slate-700 dark:hover:bg-slate-600"
          >
            <SignInIcon class="size-4 text-white" aria-hidden />
            Main UI
          </a>
        </div>
      </header>

      <section class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <TableScroll
          aria-label="Worktree services scroll area"
          class="scheme-light dark:scheme-dark"
        >
          <Table
            density="comfortable"
            aria-label="Worktree services"
            class="min-w-full"
          >
            <thead>
              <tr>
                <th scope="col" class="text-left">
                  Worktree
                </th>
                <th scope="col" class="text-left">
                  Backend
                </th>
                <th scope="col" class="text-left">
                  Web UI
                </th>
                <th scope="col" class="text-left">
                  Docs
                </th>
                <th scope="col" class="text-left">
                  Senders
                </th>
                <th scope="col" class="text-left">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={initializedWorktrees()}>
                {(worktree) => (
                  <tr class="align-top">
                    <td>
                      <div class="flex items-start gap-2">
                        <div>
                          <div class="flex items-center gap-2">
                            <strong class="text-sm text-slate-900 dark:text-slate-100">
                              {worktree.branch ?? "(detached)"}
                            </strong>
                            <Show when={worktree.isMain}>
                              <span class="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                                main
                              </span>
                            </Show>
                            <div class="group relative inline-flex">
                              <button
                                type="button"
                                onClick={() => void copyWorktreePath(worktree)}
                                class={`inline-flex items-center rounded-md border px-1.5 py-1 ${copiedPathFor() === worktree.id ? "border-emerald-300 text-emerald-700 dark:border-emerald-500 dark:text-emerald-300" : "border-slate-300 text-slate-500 hover:border-slate-400 hover:text-slate-700 dark:border-slate-600 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"}`}
                                title="Copy worktree path"
                                aria-label="Copy worktree path"
                              >
                                <FolderOpenIcon class="size-3.5" aria-hidden />
                              </button>
                              <span class="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-max max-w-[42rem] rounded-md bg-slate-900 px-2 py-1 font-mono text-xs text-white shadow-lg group-hover:block">
                                {worktree.path}
                              </span>
                            </div>
                          </div>
                          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            {worktree.envExists
                              ? `NIGHTFALL_PORT=${worktree.nightfallPort ?? "invalid"}`
                              : ".env missing"}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div class="inline-flex items-center gap-2">
                        <StatusDot
                          isReachable={worktree.observed.backendPortOpen}
                          isManagedRunning={worktree.managed.backend.running}
                          status={serviceStatusText(
                            worktree.observed.backendPortOpen,
                            worktree.managed.backend.running,
                            worktree.managed.backend.pid ??
                              worktree.observed.backendPid,
                          )}
                        >
                          <p class="font-mono text-xs text-slate-600 dark:text-slate-300">
                            {worktree.nightfallPort ?? "n/a"}
                          </p>
                        </StatusDot>
                        <ServiceLogButton
                          label="backend"
                          logPath={worktree.managed.backend.logPath}
                          pending={isPendingOperation(
                            actionKey(worktree.id, "open-log", "backend"),
                          )}
                          onOpen={() =>
                            void openServiceLog(worktree.id, "backend")
                          }
                        />
                      </div>
                    </td>
                    <td>
                      <div class="inline-flex items-center gap-2">
                        <StatusDot
                          isReachable={worktree.observed.webUiPortOpen}
                          isManagedRunning={worktree.managed.ui.running}
                          status={serviceStatusText(
                            worktree.observed.webUiPortOpen,
                            worktree.managed.ui.running,
                            worktree.managed.ui.pid ??
                              worktree.observed.webUiPid,
                          )}
                        >
                          <p class="font-mono text-xs text-slate-600 dark:text-slate-300">
                            {worktree.webUiPort ?? "n/a"}
                          </p>
                        </StatusDot>
                      </div>
                      <Show when={worktree.webUiUrl}>
                        {(url) => (
                          <a
                            href={url()}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="ml-2 inline-flex items-center p-1 text-sky-700 hover:text-sky-800 dark:text-sky-300 dark:hover:text-sky-200"
                          >
                            <ArrowSquareOutIcon
                              class="size-3 text-sky-700 dark:text-sky-300"
                              aria-hidden
                            />
                          </a>
                        )}
                      </Show>
                    </td>
                    <td>
                      <div class="space-y-2">
                        <BookServiceRow
                          label="user docs"
                          port={worktree.docsUserPort}
                          url={worktree.docsUserUrl}
                          isReachable={worktree.observed.docsUserPortOpen}
                          managed={worktree.managed["docs-user"]}
                          observedPid={worktree.observed.docsUserPid}
                          logPending={isPendingOperation(
                            actionKey(worktree.id, "open-log", "docs-user"),
                          )}
                          onOpenLog={() =>
                            void openServiceLog(worktree.id, "docs-user")
                          }
                        />
                        <BookServiceRow
                          label="developer docs"
                          port={worktree.docsDevPort}
                          url={worktree.docsDevUrl}
                          isReachable={worktree.observed.docsDevPortOpen}
                          managed={worktree.managed["docs-dev"]}
                          observedPid={worktree.observed.docsDevPid}
                          logPending={isPendingOperation(
                            actionKey(worktree.id, "open-log", "docs-dev"),
                          )}
                          onOpenLog={() =>
                            void openServiceLog(worktree.id, "docs-dev")
                          }
                        />
                      </div>
                    </td>
                    <td>
                      <div class="space-y-2">
                        <div class="flex items-center gap-2">
                          <StatusDot
                            isReachable={worktree.observed.artnetSenderRunning}
                            isManagedRunning={
                              worktree.managed["artnet-sender"].running
                            }
                            status={serviceStatusText(
                              worktree.observed.artnetSenderRunning,
                              worktree.managed["artnet-sender"].running,
                              worktree.managed["artnet-sender"].pid,
                            )}
                          >
                            <p class="font-mono text-xs text-slate-600 dark:text-slate-300">
                              art-net
                            </p>
                          </StatusDot>
                          <ServiceLogButton
                            label="art-net sender"
                            logPath={worktree.managed["artnet-sender"].logPath}
                            pending={isPendingOperation(
                              actionKey(
                                worktree.id,
                                "open-log",
                                "artnet-sender",
                              ),
                            )}
                            onOpen={() =>
                              void openServiceLog(worktree.id, "artnet-sender")
                            }
                          />
                        </div>
                        <div class="flex items-center gap-2">
                          <StatusDot
                            isReachable={worktree.observed.sacnSenderRunning}
                            isManagedRunning={
                              worktree.managed["sacn-sender"].running
                            }
                            status={serviceStatusText(
                              worktree.observed.sacnSenderRunning,
                              worktree.managed["sacn-sender"].running,
                              worktree.managed["sacn-sender"].pid,
                            )}
                          >
                            <p class="font-mono text-xs text-slate-600 dark:text-slate-300">
                              sacn
                            </p>
                          </StatusDot>
                          <ServiceLogButton
                            label="sACN sender"
                            logPath={worktree.managed["sacn-sender"].logPath}
                            pending={isPendingOperation(
                              actionKey(worktree.id, "open-log", "sacn-sender"),
                            )}
                            onOpen={() =>
                              void openServiceLog(worktree.id, "sacn-sender")
                            }
                          />
                        </div>
                      </div>
                    </td>
                    <td>
                      <div class="flex w-full items-center gap-2">
                        <div class="inline-flex rounded-md border border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800">
                          <For each={ACTION_MENU_ITEMS}>
                            {(item) => (
                              <div class="relative" data-action-menu>
                                <button
                                  type="button"
                                  class="inline-flex items-center justify-center gap-1 border-r border-slate-300 px-2 py-1.5 text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                                  title={`${item.title}...`}
                                  aria-label={`${item.title}...`}
                                  disabled={
                                    disableActionWhilePending(item.action) &&
                                    isActionPending(worktree.id, item.action)
                                  }
                                  onClick={(event) =>
                                    openActionMenuFor(
                                      worktree.id,
                                      item.action,
                                      event.currentTarget,
                                    )
                                  }
                                >
                                  <Dynamic
                                    component={item.icon}
                                    class="size-4"
                                    aria-hidden
                                  />
                                  <CaretDownIcon
                                    class="size-3 text-slate-500 dark:text-slate-300"
                                    aria-hidden
                                  />
                                </button>
                                <Show
                                  when={
                                    openActionMenu() ===
                                    actionMenuKey(worktree.id, item.action)
                                  }
                                >
                                  <Portal>
                                    <div
                                      ref={openActionMenuPanel}
                                      data-action-menu
                                      style={actionMenuStyle()}
                                      class={`rounded-md border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-600 dark:bg-slate-800 ${actionMenuPlacement() === "up" ? "origin-bottom-left" : "origin-top-left"}`}
                                    >
                                      <For
                                        each={serviceTargetGroupsForAction(
                                          item.action,
                                          senderActionsSupported(),
                                        )}
                                      >
                                        {(group, groupIndex) => (
                                          <div>
                                            <Show when={groupIndex() > 0}>
                                              <div class="my-1 border-t border-slate-200 dark:border-slate-600" />
                                            </Show>
                                            <div class="px-1">
                                              <For each={group.options}>
                                                {(target) => (
                                                  <button
                                                    type="button"
                                                    class="block w-full whitespace-nowrap rounded px-2 py-1 text-left text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-200 dark:hover:bg-slate-700"
                                                    title={
                                                      item.action !== "stop" &&
                                                      (target.value ===
                                                        "backend" ||
                                                        target.value === "both")
                                                        ? "Alt+click to launch backend with sample data"
                                                        : undefined
                                                    }
                                                    disabled={
                                                      disableActionWhilePending(
                                                        item.action,
                                                      ) &&
                                                      isActionPending(
                                                        worktree.id,
                                                        item.action,
                                                      )
                                                    }
                                                    onClick={(event) =>
                                                      void runActionFromMenu(
                                                        worktree.id,
                                                        item.action,
                                                        target.value,
                                                        {
                                                          sampleData:
                                                            event.altKey ===
                                                            true,
                                                        },
                                                      )
                                                    }
                                                  >
                                                    {target.label}
                                                  </button>
                                                )}
                                              </For>
                                            </div>
                                          </div>
                                        )}
                                      </For>
                                    </div>
                                  </Portal>
                                </Show>
                              </div>
                            )}
                          </For>
                          <WorktreeOverflowMenu
                            worktree={worktree}
                            showReseed={true}
                          />
                        </div>
                        <div class="ml-auto flex h-6 w-6 items-center justify-center">
                          <Show
                            when={hasPendingOperationForWorktree(worktree.id)}
                          >
                            <ArrowsClockwiseIcon
                              class="size-4 animate-spin text-slate-500 dark:text-slate-300"
                              aria-hidden
                            />
                          </Show>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </For>
              <Show when={uninitializedWorktrees().length > 0}>
                <tr data-table-group="true">
                  <td colSpan={6}>Uninitialized worktrees</td>
                </tr>
              </Show>
              <For each={uninitializedWorktrees()}>
                {(worktree) => (
                  <tr class="align-top">
                    <td>
                      <div class="flex items-start gap-2">
                        <div>
                          <div class="flex items-center gap-2">
                            <strong class="text-sm text-slate-900 dark:text-slate-100">
                              {worktree.branch ?? "(detached)"}
                            </strong>
                            <div class="group relative inline-flex">
                              <button
                                type="button"
                                onClick={() => void copyWorktreePath(worktree)}
                                class={`inline-flex items-center rounded-md border px-1.5 py-1 ${copiedPathFor() === worktree.id ? "border-emerald-300 text-emerald-700 dark:border-emerald-500 dark:text-emerald-300" : "border-slate-300 text-slate-500 hover:border-slate-400 hover:text-slate-700 dark:border-slate-600 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"}`}
                                title="Copy worktree path"
                                aria-label="Copy worktree path"
                              >
                                <FolderOpenIcon class="size-3.5" aria-hidden />
                              </button>
                              <span class="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-max max-w-[42rem] rounded-md bg-slate-900 px-2 py-1 font-mono text-xs text-white shadow-lg group-hover:block">
                                {worktree.path}
                              </span>
                            </div>
                          </div>
                          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            .env missing
                          </p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <p class="font-mono text-xs text-slate-500 dark:text-slate-400">
                        n/a
                      </p>
                    </td>
                    <td>
                      <p class="font-mono text-xs text-slate-500 dark:text-slate-400">
                        n/a
                      </p>
                    </td>
                    <td>
                      <p class="font-mono text-xs text-slate-500 dark:text-slate-400">
                        n/a
                      </p>
                    </td>
                    <td>
                      <p class="text-xs text-slate-500 dark:text-slate-400">
                        Unavailable until .env exists
                      </p>
                    </td>
                    <td>
                      <div class="flex w-full items-center gap-2">
                        <div class="inline-flex rounded-md border border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800">
                          <WorktreeOverflowMenu
                            worktree={worktree}
                            showReseed={false}
                          />
                        </div>
                        <div class="ml-auto flex h-6 w-6 items-center justify-center">
                          <Show
                            when={hasPendingOperationForWorktree(worktree.id)}
                          >
                            <ArrowsClockwiseIcon
                              class="size-4 animate-spin text-slate-500 dark:text-slate-300"
                              aria-hidden
                            />
                          </Show>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </Table>
        </TableScroll>

        <Show when={loading() && worktrees().length === 0}>
          <div class="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
            Loading worktrees...
          </div>
        </Show>
      </section>

      <p class="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Only processes started by this API instance are marked as managed.
      </p>
    </div>
  );
}

async function bootstrap(): Promise<void> {
  try {
    await import("preline");
  } catch (error) {
    log.warn("Preline failed to load for worktree dashboard UI:", error);
  }

  const root = document.getElementById("app");
  if (!root) {
    throw new Error("Could not find #app root");
  }

  render(
    () => (
      <IconProvider weight="regular">
        <WorktreeDashboardApp />
      </IconProvider>
    ),
    root,
  );
}

void bootstrap();
