export const PARENT_ERROR_LIMIT = 4_000;
export const SESSION_REFERENCE_LIMIT = 2_048;

export interface BoundedText {
  text: string;
  truncated: boolean;
  omittedCharacters: number;
}

export function boundText(value: string, limit: number): BoundedText {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Parent-visible text limits must be positive integers.");
  }
  if (value.length <= limit) {
    return { text: value, truncated: false, omittedCharacters: 0 };
  }
  if (limit < 32) {
    const kept = Math.max(0, limit - 1);
    return {
      text: `${value.slice(0, kept)}…`,
      truncated: true,
      omittedCharacters: value.length - kept,
    };
  }

  let kept = limit;
  let marker = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    marker = `… [${value.length - kept} characters omitted]`;
    const nextKept = Math.max(0, limit - marker.length);
    if (nextKept === kept) break;
    kept = nextKept;
  }
  const omittedCharacters = value.length - kept;
  marker = `… [${omittedCharacters} characters omitted]`;
  kept = Math.max(0, limit - marker.length);
  return {
    text: `${value.slice(0, kept)}${marker}`,
    truncated: true,
    omittedCharacters: value.length - kept,
  };
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundText(message, PARENT_ERROR_LIMIT).text;
}

export function parentVisibleError(error: unknown): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  const bounded = errorText(source);
  if (bounded === source.message) return source;
  return new Error(bounded, { cause: source });
}
