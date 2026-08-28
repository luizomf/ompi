import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const ASYNC_ACTIVITY_EVENT = 'ompi:async-activity';

export interface AsyncActivityEvent {
  source: string;
  active: number;
}

export function publishAsyncActivity(
  pi: ExtensionAPI,
  source: string,
  active: number,
): void {
  pi.events?.emit(ASYNC_ACTIVITY_EVENT, { source, active } satisfies AsyncActivityEvent);
}

export function parseAsyncActivity(value: unknown): AsyncActivityEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<AsyncActivityEvent>;
  if (typeof candidate.source !== 'string' || candidate.source.length === 0) return undefined;
  if (typeof candidate.active !== 'number' || !Number.isInteger(candidate.active) || candidate.active < 0) {
    return undefined;
  }
  return { source: candidate.source, active: candidate.active };
}
