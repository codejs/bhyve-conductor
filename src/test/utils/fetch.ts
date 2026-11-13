import { vi, type Mock } from 'vitest';

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export type FetchMock = Mock<typeof fetch>;

/** Replaces global fetch with a mock; queue responses with `mockResolvedValueOnce(jsonResponse(...))`. */
export const mockFetch = (): FetchMock => {
  const fn: FetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fn);
  return fn;
};

/** URL, method, headers and parsed body of the n-th fetch call. */
export const fetchCall = (fn: FetchMock, n: number) => {
  const call = fn.mock.calls[n];
  if (!call) throw new Error(`fetch was called ${fn.mock.calls.length} times; no call #${n}`);
  const [input, init] = call;
  const body = init?.body;
  return {
    url: String(input),
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: typeof body === 'string' && body ? (JSON.parse(body) as unknown) : undefined,
  };
};

/** Let pending promise callbacks run (works with fake timers too, since setImmediate stays real). */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A response that never comes (half-open connection); it only ends when the request's signal aborts. */
export const hangingFetch = (_input: unknown, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
  });
