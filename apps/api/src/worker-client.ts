import type { Config } from "./config.js";

export class WorkerError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function workerRequest<T>(
  config: Config,
  path: string,
  options: { method?: string; body?: unknown; actor?: string } = {},
): Promise<T> {
  let response: Response;
  try {
    const request: RequestInit = {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${config.workerSharedSecret}`,
        "content-type": "application/json",
        ...(options.actor ? { "x-dcgeomaps-actor": options.actor } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    };
    if (options.body !== undefined) request.body = JSON.stringify(options.body);
    response = await fetch(`${config.workerUrl}${path}`, request);
  } catch {
    throw new WorkerError(503, "The basemap worker is unavailable.");
  }
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Worker request failed (${response.status}).`;
    throw new WorkerError(response.status, message);
  }
  return payload as T;
}
