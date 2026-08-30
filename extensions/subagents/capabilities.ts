import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BUILTIN_TOOL_PROVIDER = "builtin";
export const CAPABILITY_PROBE_STATUS_KEY = "ompi:subagent-capabilities:v1";

const MAX_TOOLS = 256;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_PROVIDER_LENGTH = 8_000;
const MAX_PROBE_LENGTH = MAX_TOOLS * (MAX_TOOL_NAME_LENGTH + MAX_PROVIDER_LENGTH + 64);
const MAX_DIAGNOSTIC_PROBLEMS = 8;
const MAX_DIAGNOSTIC_VALUE_LENGTH = 256;

export interface ToolCapability {
  readonly name: string;
  readonly provider: string;
}

export interface CapabilitySnapshot {
  readonly tools: readonly ToolCapability[];
  readonly extensionPaths: readonly string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function assertBounded(value: string, label: string, limit: number): void {
  if (value.length === 0 || value.length > limit) {
    throw new Error(`${label} must contain between 1 and ${limit} characters.`);
  }
}

function formatBoundedList(values: readonly string[]): string {
  const visible = values.slice(0, MAX_DIAGNOSTIC_PROBLEMS);
  const suffix = values.length > visible.length ? `, and ${values.length - visible.length} more` : "";
  return `${visible.join(", ")}${suffix}`;
}

function diagnosticValue(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_VALUE_LENGTH
    ? value
    : `${value.slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH - 1)}…`;
}

function loadableProvider(tool: ReturnType<ExtensionAPI["getAllTools"]>[number]): string {
  if (tool.sourceInfo.source === "builtin") return BUILTIN_TOOL_PROVIDER;
  const provider = tool.sourceInfo.path;
  assertBounded(provider, `Provider for active tool "${tool.name}"`, MAX_PROVIDER_LENGTH);
  if (tool.sourceInfo.source === "sdk" || provider.startsWith("<")) {
    throw new Error(
      `Active tool "${tool.name}" cannot be inherited because provider "${diagnosticValue(provider)}" is not a loadable extension path.`,
    );
  }
  return provider;
}

export function captureCapabilities(pi: ExtensionAPI, restrictions?: string[]): CapabilitySnapshot {
  const active = unique(pi.getActiveTools());
  const selected = restrictions === undefined ? active : unique(restrictions);
  if (selected.length > MAX_TOOLS) {
    throw new Error(`At most ${MAX_TOOLS} active tools can be inherited by one subagent dispatch.`);
  }

  for (const name of selected) assertBounded(name, "Tool name", MAX_TOOL_NAME_LENGTH);
  const activeSet = new Set(active);
  const unavailable = selected.filter((name) => !activeSet.has(name));
  if (unavailable.length > 0) {
    throw new Error(
      `Restrictions can only keep tools active in the parent. Unavailable: ${formatBoundedList(unavailable)}.`,
    );
  }

  const configured = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  const tools = selected.map((name): ToolCapability => {
    const tool = configured.get(name);
    if (!tool) {
      throw new Error(`Parent capability mismatch: active tool "${name}" has no registered provider.`);
    }
    return { name, provider: loadableProvider(tool) };
  });
  const extensionPaths = unique(
    tools
      .map((tool) => tool.provider)
      .filter((provider) => provider !== BUILTIN_TOOL_PROVIDER),
  );
  return { tools, extensionPaths };
}

export function cloneCapabilities(snapshot: CapabilitySnapshot): CapabilitySnapshot {
  return {
    tools: snapshot.tools.map((tool) => ({ ...tool })),
    extensionPaths: [...snapshot.extensionPaths],
  };
}

export function parseCapabilityProbe(value: unknown): CapabilitySnapshot {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROBE_LENGTH) {
    throw new Error("Child capability probe returned an invalid bounded payload.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Child capability probe returned invalid JSON.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Child capability probe returned an invalid snapshot.");
  }
  const report = parsed as { version?: unknown; tools?: unknown };
  if (report.version !== 1 || !Array.isArray(report.tools) || report.tools.length > MAX_TOOLS) {
    throw new Error("Child capability probe returned an unsupported snapshot.");
  }
  const tools = report.tools.map((candidate, index): ToolCapability => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Child capability probe tool ${index + 1} is invalid.`);
    }
    const tool = candidate as { name?: unknown; provider?: unknown };
    if (typeof tool.name !== "string" || typeof tool.provider !== "string") {
      throw new Error(`Child capability probe tool ${index + 1} is invalid.`);
    }
    assertBounded(tool.name, `Child capability probe tool ${index + 1} name`, MAX_TOOL_NAME_LENGTH);
    assertBounded(tool.provider, `Child capability probe tool "${tool.name}" provider`, MAX_PROVIDER_LENGTH);
    return { name: tool.name, provider: tool.provider };
  });
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error("Child capability probe returned duplicate tool names.");
  }
  return {
    tools,
    extensionPaths: unique(
      tools
        .map((tool) => tool.provider)
        .filter((provider) => provider !== BUILTIN_TOOL_PROVIDER),
    ),
  };
}

function describeCapability(capability: ToolCapability): string {
  return `${capability.name} (${diagnosticValue(capability.provider)})`;
}

export function assertCapabilityMatch(
  promised: CapabilitySnapshot,
  actual: CapabilitySnapshot,
): void {
  const actualByName = new Map(actual.tools.map((tool) => [tool.name, tool]));
  const problems: string[] = [];
  let problemCount = 0;
  const addProblem = (problem: string) => {
    problemCount += 1;
    if (problems.length < MAX_DIAGNOSTIC_PROBLEMS) problems.push(problem);
  };

  for (const expected of promised.tools) {
    const received = actualByName.get(expected.name);
    if (!received) {
      addProblem(`${expected.name} (expected ${diagnosticValue(expected.provider)}, missing)`);
      continue;
    }
    if (received.provider !== expected.provider) {
      addProblem(
        `${expected.name} (expected ${diagnosticValue(expected.provider)}, got ${diagnosticValue(received.provider)})`,
      );
    }
    actualByName.delete(expected.name);
  }
  for (const unexpected of actualByName.values()) {
    addProblem(`unexpected ${describeCapability(unexpected)}`);
  }

  if (problemCount > 0) {
    const remaining = problemCount - problems.length;
    const suffix = remaining > 0 ? `; and ${remaining} more` : "";
    throw new Error(`Child capability preflight mismatch: ${problems.join("; ")}${suffix}.`);
  }
}
