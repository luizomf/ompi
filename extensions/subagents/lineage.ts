export interface ManagedLineage {
  readonly depth: number;
  readonly maxDepth: number;
  readonly maxChildren: number;
}

export const ROOT_LINEAGE: ManagedLineage = {
  depth: 1,
  maxDepth: 3,
  maxChildren: 12,
};

export const MANAGED_LINEAGE_ENV = "OMPI_SUBAGENT_LINEAGE";

const DEFAULT_NESTED_MAX_CHILDREN = 2;

export interface ChildCeilingInput {
  readonly maxDepth?: number;
  readonly maxChildren?: number;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function validateLineage(value: ManagedLineage): ManagedLineage {
  const depth = boundedInteger(value.depth, "Delegation depth", 1, ROOT_LINEAGE.maxDepth);
  const maxDepth = boundedInteger(
    value.maxDepth,
    "Maximum delegation depth",
    depth,
    ROOT_LINEAGE.maxDepth,
  );
  const localMaximum = depth === ROOT_LINEAGE.depth
    ? ROOT_LINEAGE.maxChildren
    : DEFAULT_NESTED_MAX_CHILDREN;
  const maxChildren = boundedInteger(
    value.maxChildren,
    "Direct active-child ceiling",
    0,
    localMaximum,
  );
  return { depth, maxDepth, maxChildren };
}

export function encodeManagedLineage(lineage: ManagedLineage): string {
  const valid = validateLineage(lineage);
  return JSON.stringify({ version: 1, ...valid });
}

export function readManagedLineage(
  environment: NodeJS.ProcessEnv = process.env,
): ManagedLineage {
  const encoded = environment[MANAGED_LINEAGE_ENV];
  delete environment[MANAGED_LINEAGE_ENV];
  if (encoded === undefined) return ROOT_LINEAGE;
  if (encoded.length === 0 || encoded.length > 256) {
    throw new Error("Managed subagent lineage metadata is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw new Error("Managed subagent lineage metadata is not valid JSON.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Managed subagent lineage metadata is invalid.");
  }
  const candidate = parsed as Partial<ManagedLineage> & { version?: unknown };
  if (
    candidate.version !== 1
    || typeof candidate.depth !== "number"
    || typeof candidate.maxDepth !== "number"
    || typeof candidate.maxChildren !== "number"
  ) {
    throw new Error("Managed subagent lineage metadata is invalid.");
  }
  return validateLineage({
    depth: candidate.depth,
    maxDepth: candidate.maxDepth,
    maxChildren: candidate.maxChildren,
  });
}

export function createChildLineage(
  parent: ManagedLineage,
  requested: ChildCeilingInput = {},
): ManagedLineage {
  if (parent.depth >= parent.maxDepth) {
    throw new Error(
      `Subagent is at maximum delegation depth ${parent.maxDepth}; no child process was launched.`,
    );
  }
  const depth = parent.depth + 1;
  const inheritedMaxChildren = Math.min(DEFAULT_NESTED_MAX_CHILDREN, parent.maxChildren);
  return {
    depth,
    maxDepth: requested.maxDepth === undefined
      ? parent.maxDepth
      : boundedInteger(requested.maxDepth, "Child maximum depth", depth, parent.maxDepth),
    maxChildren: requested.maxChildren === undefined
      ? inheritedMaxChildren
      : boundedInteger(
        requested.maxChildren,
        "Child direct active-child ceiling",
        0,
        inheritedMaxChildren,
      ),
  };
}

export function tightenLineage(
  current: ManagedLineage,
  requested: ChildCeilingInput,
): ManagedLineage {
  if (requested.maxDepth !== undefined && requested.maxDepth > current.maxDepth) {
    throw new Error(
      `Continuation cannot raise maximum delegation depth above ${current.maxDepth}.`,
    );
  }
  if (requested.maxChildren !== undefined && requested.maxChildren > current.maxChildren) {
    throw new Error(
      `Continuation cannot raise the direct active-child ceiling above ${current.maxChildren}.`,
    );
  }
  return {
    depth: current.depth,
    maxDepth: requested.maxDepth === undefined
      ? current.maxDepth
      : boundedInteger(
        requested.maxDepth,
        "Continuation maximum depth",
        current.depth,
        current.maxDepth,
      ),
    maxChildren: requested.maxChildren === undefined
      ? current.maxChildren
      : boundedInteger(
        requested.maxChildren,
        "Continuation direct active-child ceiling",
        0,
        current.maxChildren,
      ),
  };
}
