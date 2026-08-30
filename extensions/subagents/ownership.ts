import type {
  ActiveSubagentState,
  OwnershipRuntime,
  ThinkingLevel,
} from "./controller.ts";

export const OWNERSHIP_STATUS_KEY = "ompi:subagents:ownership-v1";

const MAX_FRAME_BYTES = 16_000;
const MAX_RUNTIMES = 32;
const MAX_RELATIVE_PATH = 2;
const MAX_NAME_LENGTH = 80;
const MAX_MODEL_LENGTH = 160;
const ACTIVE_STATES = new Set<ActiveSubagentState>([
  "handshaking",
  "running",
  "steering",
  "interrupting",
  "finalizing",
]);
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function invalid(): never {
  throw new Error("Managed subagent ownership status is invalid.");
}

function oneLine(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? compact.slice(0, limit) : compact;
}

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validPath(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_RELATIVE_PATH
    && value.every(positiveId);
}

function samePath(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseRuntime(value: unknown): OwnershipRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const candidate = value as Partial<OwnershipRuntime>;
  if (
    !validPath(candidate.path)
    || !Array.isArray(candidate.parentPath)
    || candidate.parentPath.some((id) => !positiveId(id))
    || !samePath(candidate.parentPath, candidate.path.slice(0, -1))
    || !positiveId(candidate.id)
    || candidate.id !== candidate.path.at(-1)
    || typeof candidate.depth !== "number"
    || !Number.isInteger(candidate.depth)
    || candidate.depth < 2
    || candidate.depth > 3
    || typeof candidate.state !== "string"
    || !ACTIVE_STATES.has(candidate.state as ActiveSubagentState)
    || typeof candidate.model !== "string"
    || candidate.model.length === 0
    || candidate.model.length > MAX_MODEL_LENGTH
    || /[\r\n]/.test(candidate.model)
    || typeof candidate.thinking !== "string"
    || !THINKING_LEVELS.has(candidate.thinking as ThinkingLevel)
    || (candidate.name !== undefined && (
      typeof candidate.name !== "string"
      || candidate.name.length === 0
      || candidate.name.length > MAX_NAME_LENGTH
      || /[\r\n]/.test(candidate.name)
    ))
  ) {
    invalid();
  }
  const allowedKeys = new Set([
    "path",
    "parentPath",
    "id",
    "depth",
    "state",
    "name",
    "model",
    "thinking",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) invalid();
  return {
    path: [...candidate.path],
    parentPath: [...candidate.parentPath],
    id: candidate.id,
    depth: candidate.depth,
    state: candidate.state as ActiveSubagentState,
    name: candidate.name,
    model: candidate.model,
    thinking: candidate.thinking as ThinkingLevel,
  };
}

export function encodeOwnershipStatus(ownership: OwnershipRuntime[]): string {
  const safe = ownership.map((runtime) => {
    const name = runtime.name ? oneLine(runtime.name, MAX_NAME_LENGTH) : undefined;
    return {
      ...runtime,
      name: name || undefined,
      model: oneLine(runtime.model, MAX_MODEL_LENGTH),
    };
  });
  const encoded = JSON.stringify({ version: 1, ownership: safe });
  if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) invalid();
  return JSON.stringify({ version: 1, ownership: safe.map(parseRuntime) });
}

export function parseOwnershipStatus(value: unknown): OwnershipRuntime[] {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_FRAME_BYTES) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Managed subagent ownership status is not valid JSON.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
  const candidate = parsed as { version?: unknown; ownership?: unknown };
  if (
    candidate.version !== 1
    || !Array.isArray(candidate.ownership)
    || candidate.ownership.length > MAX_RUNTIMES
    || Object.keys(parsed).some((key) => key !== "version" && key !== "ownership")
  ) {
    invalid();
  }
  const ownership = candidate.ownership.map(parseRuntime);
  const paths = new Set<string>();
  const ownerDepths = new Set<number>();
  for (const runtime of ownership) {
    const path = runtime.path.join("/");
    const parent = runtime.parentPath.join("/");
    if (paths.has(path) || (parent && !paths.has(parent))) invalid();
    paths.add(path);
    ownerDepths.add(runtime.depth - runtime.path.length);
  }
  if (
    ownerDepths.size > 1
    || [...ownerDepths].some((depth) => depth < 1 || depth > 2)
  ) {
    invalid();
  }
  return ownership;
}
