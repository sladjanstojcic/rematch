export const USER_AGENT = 'RematchBot/0.1 (+https://github.com/rematch-app)';

type FetchOptions = { timeoutMs?: number; retries?: number };

export class HttpError extends Error {
  constructor(
    public readonly url: string,
    // Zero means the request failed before receiving an HTTP response.
    public readonly status: number,
    message = `HTTP request failed (${status})`,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

async function requestText(
  url: string,
  { timeoutMs = 20_000, retries = 2 }: FetchOptions = {},
): Promise<{ text: string; status: number }> {
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        // Release the unread body before retrying or reporting the HTTP failure.
        try { await response.body?.cancel(); } finally {
          throw new HttpError(url, response.status);
        }
      }
      return { text: await response.text(), status: response.status };
    } catch (error) {
      const retryable = !(error instanceof HttpError)
        || error.status === 429 || (error.status >= 500 && error.status <= 599);
      if (!retryable || attempt >= retries) {
        throw error instanceof HttpError ? error : new HttpError(url, response?.status ?? 0);
      }
    }
    // Default retries wait 500 ms and then 1500 ms.
    await new Promise((resolve) => setTimeout(resolve, 500 * 3 ** attempt));
  }
}

export async function fetchText(url: string, opts?: FetchOptions): Promise<string> {
  return (await requestText(url, opts)).text;
}

export async function fetchJson<T>(url: string, opts?: FetchOptions): Promise<T> {
  const { text, status } = await requestText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(url, status, 'Response body is not valid JSON');
  }
}
