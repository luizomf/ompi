import {
  ExtensionEditorComponent,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

export const STANDARD_DIALOG_METHODS = ["select", "confirm", "input", "editor"] as const;
export const DIALOG_RELAY_TIMEOUT_MS = 30_000;
export type StandardDialogMethod = (typeof STANDARD_DIALOG_METHODS)[number];

interface DialogBase {
  id: string;
  method: StandardDialogMethod;
  title: string;
  timeout?: number;
}

export interface SelectDialogRequest extends DialogBase {
  method: "select";
  options: string[];
}

export interface ConfirmDialogRequest extends DialogBase {
  method: "confirm";
  message: string;
}

export interface InputDialogRequest extends DialogBase {
  method: "input";
  placeholder?: string;
}

export interface EditorDialogRequest extends DialogBase {
  method: "editor";
  prefill?: string;
}

export type StandardDialogRequest =
  | SelectDialogRequest
  | ConfirmDialogRequest
  | InputDialogRequest
  | EditorDialogRequest;

export type StandardDialogResult =
  | { cancelled: true }
  | { confirmed: boolean }
  | { value: string };

export interface DialogRelayOptions {
  interactiveEditor?: boolean;
}

const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 2_000;
const MAX_TEXT_LENGTH = 8_000;
const MAX_OPTION_LENGTH = 1_000;
const MAX_OPTIONS = 100;
const MAX_TIMEOUT_MS = 120_000;
const METHOD_SET = new Set<string>(STANDARD_DIALOG_METHODS);

function invalid(): never {
  throw new Error("Standard child dialog request is invalid.");
}

function boundedString(value: unknown, maximum: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length > maximum || /[\u0000]/.test(value)) invalid();
  return value;
}

function timeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > MAX_TIMEOUT_MS) invalid();
  return Number(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) invalid();
}

export function isStandardDialogMethod(value: unknown): value is StandardDialogMethod {
  return typeof value === "string" && METHOD_SET.has(value);
}

export function parseStandardDialogRequest(value: unknown): StandardDialogRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "extension_ui_request"
    || typeof candidate.id !== "string"
    || candidate.id.length === 0
    || candidate.id.length > MAX_ID_LENGTH
    || !isStandardDialogMethod(candidate.method)
  ) {
    invalid();
  }
  const parsedTimeout = timeout(candidate.timeout);
  const base = {
    id: candidate.id,
    title: boundedString(candidate.title, MAX_TITLE_LENGTH) ?? "",
    ...(parsedTimeout === undefined ? {} : { timeout: parsedTimeout }),
  };
  switch (candidate.method) {
    case "select": {
      exactKeys(candidate, ["type", "id", "method", "title", "options", "timeout"]);
      if (
        !Array.isArray(candidate.options)
        || candidate.options.length > MAX_OPTIONS
        || candidate.options.some((option) => (
          typeof option !== "string"
          || option.length > MAX_OPTION_LENGTH
          || /[\u0000]/.test(option)
        ))
      ) {
        invalid();
      }
      return { ...base, method: "select", options: [...candidate.options] };
    }
    case "confirm":
      exactKeys(candidate, ["type", "id", "method", "title", "message", "timeout"]);
      return {
        ...base,
        method: "confirm",
        message: boundedString(candidate.message, MAX_TEXT_LENGTH) ?? "",
      };
    case "input":
      exactKeys(candidate, ["type", "id", "method", "title", "placeholder", "timeout"]);
      const placeholder = boundedString(candidate.placeholder, MAX_TEXT_LENGTH, true);
      return {
        ...base,
        method: "input",
        ...(placeholder === undefined ? {} : { placeholder }),
      };
    case "editor":
      exactKeys(candidate, ["type", "id", "method", "title", "prefill", "timeout"]);
      const prefill = boundedString(candidate.prefill, MAX_TEXT_LENGTH, true);
      return {
        ...base,
        method: "editor",
        ...(prefill === undefined ? {} : { prefill }),
      };
  }
}

export function cancelledDialogResult(): StandardDialogResult {
  return { cancelled: true };
}

const RELAY_CANCELLED = Symbol("relay-cancelled");

async function withinRelayDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T | typeof RELAY_CANCELLED> {
  if (signal.aborted) return RELAY_CANCELLED;
  let timer: number | NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<typeof RELAY_CANCELLED>((resolve) => {
    abort = () => resolve(RELAY_CANCELLED);
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => resolve(RELAY_CANCELLED), timeoutMs);
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function relayInteractiveEditor(
  ui: ExtensionUIContext,
  request: EditorDialogRequest,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<StandardDialogResult> {
  if (signal.aborted) return cancelledDialogResult();
  let cleanup = () => undefined;
  try {
    const value = await ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: string | undefined) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        done(result);
      };
      const abort = () => finish(undefined);
      cleanup = () => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish(undefined), timeoutMs);
      if (signal.aborted) queueMicrotask(abort);
      return new ExtensionEditorComponent(
        tui,
        keybindings,
        request.title,
        request.prefill,
        (result) => finish(result),
        () => finish(undefined),
      );
    });
    return value === undefined ? cancelledDialogResult() : { value };
  } catch {
    return cancelledDialogResult();
  } finally {
    cleanup();
  }
}

export async function relayStandardDialog(
  ui: ExtensionUIContext,
  request: StandardDialogRequest,
  signal: AbortSignal,
  options: DialogRelayOptions = {},
): Promise<StandardDialogResult> {
  if (signal.aborted) return cancelledDialogResult();
  const relayTimeout = Math.min(request.timeout ?? DIALOG_RELAY_TIMEOUT_MS, DIALOG_RELAY_TIMEOUT_MS);
  const settings = { signal, timeout: relayTimeout };
  try {
    switch (request.method) {
      case "select": {
        const value = await withinRelayDeadline(
          ui.select(request.title, request.options, settings),
          signal,
          relayTimeout,
        );
        return value === RELAY_CANCELLED || value === undefined
          ? cancelledDialogResult()
          : { value };
      }
      case "confirm": {
        const confirmed = await withinRelayDeadline(
          ui.confirm(request.title, request.message, settings),
          signal,
          relayTimeout,
        );
        return confirmed === RELAY_CANCELLED
          ? cancelledDialogResult()
          : { confirmed };
      }
      case "input": {
        const value = await withinRelayDeadline(
          ui.input(request.title, request.placeholder, settings),
          signal,
          relayTimeout,
        );
        return value === RELAY_CANCELLED || value === undefined
          ? cancelledDialogResult()
          : { value };
      }
      case "editor": {
        if (options.interactiveEditor) {
          return relayInteractiveEditor(ui, request, signal, relayTimeout);
        }
        const value = await withinRelayDeadline(
          ui.editor(request.title, request.prefill),
          signal,
          relayTimeout,
        );
        return value === RELAY_CANCELLED || value === undefined
          ? cancelledDialogResult()
          : { value };
      }
    }
  } catch {
    return cancelledDialogResult();
  }
}

export function normalizeDialogResult(
  request: StandardDialogRequest,
  result: StandardDialogResult,
): StandardDialogResult {
  if ("cancelled" in result && result.cancelled === true) return cancelledDialogResult();
  if (request.method === "confirm") {
    return "confirmed" in result && typeof result.confirmed === "boolean"
      ? { confirmed: result.confirmed }
      : cancelledDialogResult();
  }
  if (!("value" in result) || typeof result.value !== "string" || result.value.length > MAX_TEXT_LENGTH) {
    return cancelledDialogResult();
  }
  if (request.method === "select" && !request.options.includes(result.value)) {
    return cancelledDialogResult();
  }
  return { value: result.value };
}
