// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/** Models native IPC against a real fixture log file while exercising the desktop UI in Chromium. */
export async function installDiagnosticNativeMock(
  page: Page,
  path: string,
  port: number,
) {
  writeFileSync(
    path,
    `${JSON.stringify({ level: "WARN", target: "engine", fields: { message: "stored backend warning" } })}\n`,
  );
  await page.exposeFunction(
    "diagnosticFileIpc",
    (command: string, args: Record<string, unknown>) => {
      if (command === "plugin:log|log") {
        const levels = ["", "TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
        appendFileSync(
          path,
          `${JSON.stringify({ level: levels[Number(args.level)], target: "webview", fields: { message: args.message } })}\n`,
        );
        return;
      }
      if (command === "collect_diagnostic_logs") {
        const file = readFileSync(path);
        const fileLength = Math.min(
          Number(args.fileLength ?? file.length),
          file.length,
        );
        const offset = Number(args.offset ?? 0);
        const lines = file
          .subarray(offset, fileLength)
          .toString("utf8")
          .trimEnd()
          .split("\n")
          .filter(Boolean);
        const entries = lines.map((line) => JSON.parse(line));
        const selected =
          args.mode === "recent"
            ? entries
                .filter((entry) => ["WARN", "ERROR"].includes(entry.level))
                .slice(-20)
            : entries.slice(0, 100);
        const next =
          offset +
          Buffer.byteLength(lines.slice(0, selected.length).join("\n")) +
          (selected.length ? 1 : 0);
        return {
          entries: selected.map((entry) => {
            const { message, ...fields } = entry.fields;
            return {
              timestamp: entry.timestamp ?? "",
              level: entry.level,
              target: entry.target,
              message,
              fields: Object.entries(fields).map(([name, value]) => ({
                name,
                value:
                  typeof value === "string" ? value : JSON.stringify(value),
              })),
              shortened: false,
            };
          }),
          nextOffset: args.mode === "all" && next < fileLength ? next : null,
          fileLength,
        };
      }
      throw new Error(`Unexpected file command: ${command}`);
    },
  );
  await page.addInitScript((backendPort) => {
    const desktop = window as any;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<number, number>();
    let nextId = 1;
    desktop.isTauri = true;
    desktop.__NIGHTFALL_BACKEND_PORT__ = backendPort;
    desktop.__TAURI_INTERNALS__ = {
      metadata: {
        currentWebview: { label: "main" },
        currentWindow: { label: "main" },
      },
      /** Registers the callback used by the native menu event API. */
      transformCallback(callback: (event: unknown) => void) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      /** Routes logging to the fixture file and emulates native export and menu responses. */
      async invoke(command: string, args: Record<string, unknown>) {
        if (command === "plugin:event|listen") {
          const id = nextId++;
          listeners.set(id, args.handler as number);
          return id;
        }
        if (command === "plugin:event|unlisten") return;
        if (command === "export_diagnostics") {
          desktop.saveDialogOpened = true;
          if (desktop.cancelSave) return null;
          if (desktop.failExport) throw new Error("Downloads is read-only");
          desktop.exportedOptions = args.options;
          return {
            path:
              desktop.saveDestination ??
              "/Downloads/nightfall-diagnostics-test.zip",
            warnings: desktop.exportWarnings ?? [],
          };
        }
        if (command === "open_bug_report") {
          if (desktop.failBugReport) throw new Error("Browser unavailable");
          desktop.bugReportUrl = args.url;
          return;
        }
        if (command === "perform_menu_action") {
          desktop.lastMenuAction = args.actionId;
          return;
        }
        if (command === "collect_diagnostic_logs" && desktop.failCollection)
          throw new Error("Log file unavailable");
        return desktop.diagnosticFileIpc(command, args);
      },
    };
    desktop.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      /** Removes subscriptions released by the shell. */
      unregisterListener(_event: string, id: number) {
        listeners.delete(id);
      },
    };
    /** Delivers the native Collect Diagnostics menu event. */
    desktop.emitDiagnosticMenu = (action = "app.diagnostics") => {
      for (const [id, handler] of listeners)
        callbacks.get(handler)?.({
          event: "nightfall:menu-action",
          id,
          payload: action,
        });
    };
    /** Reports menu readiness without arbitrary delays. */
    desktop.diagnosticListenerCount = () => listeners.size;
  }, port);
}
