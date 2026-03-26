// Shared HAR (HTTP Archive) types and helpers.
// Used by both client.ts (standalone mode) and relay.ts (extension mode).

export interface HarCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface HarPostData {
  mimeType: string;
  text: string;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: string;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    cookies: HarCookie[];
    headersSize: number;
    bodySize: number;
    postData?: HarPostData;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    cookies: HarCookie[];
    content: HarContent;
    headersSize: number;
    bodySize: number;
  };
  timings: { send: number; wait: number; receive: number };
}

export interface HarLog {
  log: {
    version: string;
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

export interface PendingHarEntry {
  entry: Partial<HarEntry>;
  startTime: number;
  requestId: string;
  mimeType?: string;
}

// Parse Cookie header into HarCookie array
export function parseCookieHeader(cookieHeader: string): HarCookie[] {
  if (!cookieHeader) return [];
  return cookieHeader.split(";").map((part) => {
    const [name, ...rest] = part.trim().split("=");
    return { name: name ?? "", value: rest.join("=") };
  });
}

// Callback for mode-specific response body retrieval.
// Returns body text + encoding flag, or null if unavailable.
export type FetchBodyFn = (
  requestId: string
) => Promise<{ body?: string; base64Encoded?: boolean } | null>;

/**
 * Shared HAR network event state machine.
 * Processes CDP Network.* events into HAR entries.
 * The fetchBody callback is called for text responses to retrieve body content;
 * it fires asynchronously and the entry is pushed to completed immediately.
 */
export function processNetworkEvent(
  pending: Map<string, PendingHarEntry>,
  completed: HarEntry[],
  method: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>,
  fetchBody: FetchBodyFn
): void {
  if (method === "Network.requestWillBeSent") {
    const url = new URL(params.request.url);
    const headers = Object.entries(params.request.headers).map(([n, v]) => ({
      name: n,
      value: String(v),
    }));
    const cookieHeader =
      params.request.headers["Cookie"] ?? params.request.headers["cookie"] ?? "";
    const cookies = parseCookieHeader(cookieHeader);
    const postData = params.request.postData
      ? {
          mimeType:
            params.request.headers["Content-Type"] ??
            params.request.headers["content-type"] ??
            "application/octet-stream",
          text: params.request.postData,
        }
      : undefined;

    pending.set(params.requestId, {
      startTime: params.timestamp * 1000,
      requestId: params.requestId,
      entry: {
        startedDateTime: new Date(params.wallTime * 1000).toISOString(),
        request: {
          method: params.request.method,
          url: params.request.url,
          httpVersion: "HTTP/1.1",
          headers,
          queryString: [...url.searchParams].map(([n, v]) => ({
            name: n,
            value: v,
          })),
          cookies,
          headersSize: -1,
          bodySize: params.request.postData?.length ?? 0,
          postData,
        },
      },
    });
  } else if (method === "Network.responseReceived") {
    const entry = pending.get(params.requestId);
    if (!entry) return;

    const headers = Object.entries(params.response.headers).map(([n, v]) => ({
      name: n,
      value: String(v),
    }));
    const resCookies: HarCookie[] = [];
    for (const [hName, hValue] of Object.entries(params.response.headers)) {
      if (hName.toLowerCase() === "set-cookie") {
        resCookies.push(parseSetCookie(String(hValue)));
      }
    }

    const timing = params.response.timing;
    entry.mimeType = params.response.mimeType;
    entry.entry.response = {
      status: params.response.status,
      statusText: params.response.statusText,
      httpVersion: params.response.protocol ?? "HTTP/1.1",
      headers,
      cookies: resCookies,
      content: {
        size: params.response.encodedDataLength ?? 0,
        mimeType: params.response.mimeType,
      },
      headersSize: -1,
      bodySize: -1,
    };

    if (timing) {
      entry.entry.timings = {
        send: timing.sendEnd - timing.sendStart,
        wait: timing.receiveHeadersEnd - timing.sendEnd,
        receive: 0,
      };
    }
  } else if (method === "Network.loadingFinished") {
    const entry = pending.get(params.requestId);
    if (!entry?.entry.response) return;

    const endTime = params.timestamp * 1000;
    entry.entry.time = endTime - entry.startTime;
    entry.entry.response.bodySize = params.encodedDataLength;

    if (entry.entry.timings) {
      entry.entry.timings.receive = Math.max(
        0,
        entry.entry.time - (entry.entry.timings.send + entry.entry.timings.wait)
      );
    } else {
      entry.entry.timings = {
        send: 0,
        wait: entry.entry.time,
        receive: 0,
      };
    }

    // Fetch response body for text content
    const isText =
      entry.mimeType?.startsWith("text/") ||
      entry.mimeType?.includes("json") ||
      entry.mimeType?.includes("xml") ||
      entry.mimeType?.includes("javascript");
    if (isText && params.encodedDataLength < 1024 * 1024) {
      fetchBody(params.requestId)
        .then((result) => {
          if (result?.body) {
            entry.entry.response!.content.text = result.body;
            if (result.base64Encoded) {
              entry.entry.response!.content.encoding = "base64";
            }
          }
        })
        .catch(() => {
          // Body may not be available
        });
    }

    completed.push(entry.entry as HarEntry);
    pending.delete(params.requestId);
  } else if (method === "Network.loadingFailed") {
    pending.delete(params.requestId);
  }
}

// Parse Set-Cookie header into HarCookie
export function parseSetCookie(setCookie: string): HarCookie {
  const parts = setCookie.split(";").map((p) => p.trim());
  const [nameValue, ...attrs] = parts;
  const [name, ...rest] = (nameValue ?? "").split("=");
  const cookie: HarCookie = { name: name ?? "", value: rest.join("=") };

  for (const attr of attrs) {
    const [key, val] = attr.split("=");
    const lowerKey = key?.toLowerCase();
    if (lowerKey === "path") cookie.path = val;
    else if (lowerKey === "domain") cookie.domain = val;
    else if (lowerKey === "expires") cookie.expires = val;
    else if (lowerKey === "httponly") cookie.httpOnly = true;
    else if (lowerKey === "secure") cookie.secure = true;
    else if (lowerKey === "samesite") cookie.sameSite = val;
  }
  return cookie;
}
