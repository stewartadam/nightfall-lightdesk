// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { buildLogger, type LoggerOptions } from "@nanostores/logger";
import { LogLevel } from "loglayer";
import {
  createLogger,
  type ModuleLogger,
  subscribeToConfigChanges,
} from "./logger";
import {
  collectNanostoreEntries,
  type NanostoreRegistryEntry,
} from "./nanostore-registry";

const ROOT_MODULE = "nanostores";

const LOGGER_OPTIONS: LoggerOptions = {
  messages: {
    mount: false,
    unmount: false,
  },
};

type DestroyLogger = () => void;
type BuildStoreLogger = typeof buildLogger;
type CreateModuleLogger = typeof createLogger;
type SubscribeToLogConfigChanges = typeof subscribeToConfigChanges;
type MessageStyle = "bold" | "regular";
type StyledMessage = [MessageStyle, string][];
type StyledLogType =
  | "action"
  | "arguments"
  | "change"
  | "error"
  | "new"
  | "old"
  | "value";
type QueuedLog = () => void;

export type NanostoreLoggerEntry = Pick<
  NanostoreRegistryEntry,
  "name" | "store"
>;

interface NanostoresLoggerControllerOptions {
  buildStoreLogger?: BuildStoreLogger;
  createModuleLogger?: CreateModuleLogger;
  stores?: NanostoreLoggerEntry[];
  subscribeToLogConfigChanges?: SubscribeToLogConfigChanges;
}

export interface NanostoresLoggerController {
  activeStoreNames: () => string[];
  destroy: () => void;
  refresh: () => void;
  registeredStoreNames: () => string[];
}

let activeController: NanostoresLoggerController | null = null;

/**
 * Create badge CSS matching @nanostores/logger's console presentation.
 */
function badge(color: string): string {
  return `
    padding: 0 5px 2px;
    margin-right: 5px;
    font-weight: 400;
    color: white;
    background-color: ${color};
  `;
}

/**
 * Create badge border CSS, accounting for the optional Nano Stores logo badge.
 */
function borders(full: boolean): string {
  return `border-radius: ${full ? "4px" : "0 4px 4px 0"};`;
}

const STYLES = {
  badges: {
    action: badge("#00899A"),
    arguments: badge("#007281"),
    change: badge("#0E8A00"),
    error: badge("#C30000"),
    new: badge("#0C7800"),
    old: badge("#943636"),
    value: badge("#8A6F00"),
  },
  bold: "font-weight: 700;",
  logo: `
    padding: 0 5px 2px;
    color: white;
    background-color: black;
    border-radius: 4px 0 0 4px;
  `,
  regular: "font-weight: 400;",
};

/**
 * Convert a styled Nano Stores trace entry to console arguments.
 */
function createStyledLog(args: {
  logo?: boolean;
  message?: string | StyledMessage;
  type: StyledLogType;
  value?: unknown;
}): unknown[] {
  let template = "";
  const values: unknown[] = [];

  if (args.logo) {
    template = "%c𝖓";
    values.push(STYLES.logo);
  }

  template += `%c${args.type}`;
  values.push(STYLES.badges[args.type] + borders(!args.logo));

  if (args.message) {
    if (Array.isArray(args.message)) {
      for (const [style, text] of args.message) {
        template += `%c ${text}`;
        values.push(STYLES[style]);
      }
    } else {
      template += `%c ${args.message}`;
      values.push(STYLES.regular);
    }
  }

  if (args.value !== undefined) {
    values.push(args.value);
  }

  values.unshift(template);
  return values;
}

/**
 * Write a styled trace line to the browser console.
 */
function logStyled(args: {
  logo?: boolean;
  message?: string | StyledMessage;
  type: StyledLogType;
  value?: unknown;
}): void {
  console.log(...createStyledLog(args));
}

/**
 * Start a styled collapsed console group.
 */
function groupStyled(args: {
  logo?: boolean;
  message?: string | StyledMessage;
  type: StyledLogType;
  value?: unknown;
}): void {
  console.groupCollapsed(...createStyledLog(args));
}

/**
 * End the current styled console group.
 */
function groupEndStyled(): void {
  console.groupEnd();
}

/**
 * Choose the logger that currently enables a store trace.
 */
function activeLoggerForStore(
  rootLogger: ModuleLogger,
  storeLogger: ModuleLogger,
): ModuleLogger | null {
  if (rootLogger.isEnabled(LogLevel.trace)) return rootLogger;
  if (storeLogger.isEnabled(LogLevel.trace)) return storeLogger;
  return null;
}

/**
 * Create the labeled message for a store change.
 */
function changeMessage(payload: {
  changed?: string | number | symbol;
  storeName: string;
}): StyledMessage {
  const message: StyledMessage = [
    ["bold", payload.storeName],
    ["regular", "store was changed"],
  ];

  if (payload.changed !== undefined) {
    message.push(
      ["regular", "in the"],
      ["bold", String(payload.changed)],
      ["regular", "key"],
    );
  }

  return message;
}

/**
 * Log the details for a store change inside its own collapsed group.
 */
function logChangeGroup(payload: {
  changed?: string | number | symbol;
  logo: boolean;
  newValue?: unknown;
  oldValue?: unknown;
  storeName: string;
  valueMessage?: string;
}): void {
  groupStyled({
    logo: payload.logo,
    message: changeMessage(payload),
    type: "change",
  });

  if (payload.valueMessage) {
    logStyled({
      message: payload.valueMessage,
      type: "value",
    });
  }

  if (payload.newValue !== undefined) {
    logStyled({
      type: "new",
      value: payload.newValue,
    });
  }

  if (payload.oldValue !== undefined) {
    logStyled({
      type: "old",
      value: payload.oldValue,
    });
  }

  groupEndStyled();
}

/**
 * Create the callback object consumed by @nanostores/logger.
 */
function createLoggerEvents(
  storeName: string,
  rootLogger: ModuleLogger,
  storeLogger: ModuleLogger,
) {
  const actionQueue = new Map<number, QueuedLog[]>();

  return {
    action: {
      end: (payload: { actionId: number; actionName: string }) => {
        const logger = activeLoggerForStore(rootLogger, storeLogger);
        if (!logger) return;
        const queuedLogs = actionQueue.get(payload.actionId);
        if (!queuedLogs) return;

        for (const logEntry of queuedLogs) {
          logEntry();
        }
        actionQueue.delete(payload.actionId);
        groupEndStyled();
      },
      error: (payload: {
        actionId: number;
        actionName: string;
        error: Error;
      }) => {
        const logger = activeLoggerForStore(rootLogger, storeLogger);
        if (!logger) return;
        actionQueue.get(payload.actionId)?.push(() =>
          logStyled({
            message: [
              ["bold", storeName],
              ["regular", "store handled error in action"],
              ["bold", payload.actionName],
            ],
            type: "error",
            value: {
              message: payload.error.message,
            },
          }),
        );
      },
      start: (payload: {
        actionId: number;
        actionName: string;
        args: unknown[];
      }) => {
        const logger = activeLoggerForStore(rootLogger, storeLogger);
        if (!logger) return;
        const message: StyledMessage = [
          ["bold", storeName],
          ["regular", "store was changed by action"],
          ["bold", payload.actionName],
        ];
        const queuedLogs: QueuedLog[] = [
          () =>
            groupStyled({
              logo: true,
              message,
              type: "action",
            }),
        ];

        if (payload.args.length > 0) {
          message.push(["regular", "with arguments"]);
          queuedLogs.push(() =>
            logStyled({
              type: "arguments",
              value: payload.args,
            }),
          );
        }

        actionQueue.set(payload.actionId, queuedLogs);
      },
    },
    change: (payload: {
      actionId?: number;
      actionName?: string;
      changed?: string | number | symbol;
      newValue?: unknown;
      oldValue?: unknown;
      storeName: string;
      valueMessage?: string;
    }) => {
      const logger = activeLoggerForStore(rootLogger, storeLogger);
      if (!logger) return;
      const run = () =>
        logChangeGroup({
          changed: payload.changed,
          logo: payload.actionId === undefined,
          newValue: payload.newValue,
          oldValue: payload.oldValue,
          storeName,
          valueMessage: payload.valueMessage,
        });

      if (payload.actionId !== undefined) {
        actionQueue.get(payload.actionId)?.push(run);
      } else {
        run();
      }
    },
  };
}

/**
 * Create a controller that installs Nano Store loggers according to log config.
 */
export function createNanostoresLoggerController(
  options: NanostoresLoggerControllerOptions = {},
): NanostoresLoggerController {
  const buildStoreLogger = options.buildStoreLogger ?? buildLogger;
  const createModuleLogger = options.createModuleLogger ?? createLogger;
  const subscribeToLogConfig =
    options.subscribeToLogConfigChanges ?? subscribeToConfigChanges;
  const stores = options.stores ?? collectNanostoreEntries();
  const rootLogger = createModuleLogger(ROOT_MODULE);
  const storeLoggers = new Map<string, ModuleLogger>();
  const activeDestroyers = new Map<string, DestroyLogger>();

  /** Get or create the module logger for a registered store. */
  function loggerForStore(storeName: string): ModuleLogger {
    let logger = storeLoggers.get(storeName);
    if (!logger) {
      logger = createModuleLogger(`${ROOT_MODULE}:${storeName}`);
      storeLoggers.set(storeName, logger);
    }
    return logger;
  }

  /** Determine whether a store currently has root or direct trace enabled. */
  function shouldTraceStore(storeName: string): boolean {
    return (
      rootLogger.isEnabled(LogLevel.trace) ||
      loggerForStore(storeName).isEnabled(LogLevel.trace)
    );
  }

  /** Install or remove store subscriptions to match current log config. */
  function refresh(): void {
    for (const entry of stores) {
      const enabled = shouldTraceStore(entry.name);
      const activeDestroyer = activeDestroyers.get(entry.name);

      if (enabled && !activeDestroyer) {
        const storeLogger = loggerForStore(entry.name);
        activeDestroyers.set(
          entry.name,
          buildStoreLogger(
            entry.store,
            entry.name,
            createLoggerEvents(entry.name, rootLogger, storeLogger),
            LOGGER_OPTIONS,
          ),
        );
      } else if (!enabled && activeDestroyer) {
        activeDestroyer();
        activeDestroyers.delete(entry.name);
      }
    }
  }

  const unsubscribe = subscribeToLogConfig(() => refresh());
  refresh();

  return {
    activeStoreNames: () => Array.from(activeDestroyers.keys()).sort(),
    destroy: () => {
      unsubscribe();
      for (const destroy of activeDestroyers.values()) {
        destroy();
      }
      activeDestroyers.clear();
    },
    refresh,
    registeredStoreNames: () => stores.map((store) => store.name),
  };
}

/**
 * Start the singleton Nano Stores logger service for the browser app.
 */
export function startNanostoresLogger(): NanostoresLoggerController {
  activeController?.destroy();
  activeController = createNanostoresLoggerController();
  return activeController;
}

/**
 * Stop the singleton Nano Stores logger service.
 */
export function stopNanostoresLogger(): void {
  activeController?.destroy();
  activeController = null;
}
