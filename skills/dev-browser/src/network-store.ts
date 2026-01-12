/**
 * Network Store - Captures and stores network request data for debugging
 *
 * This module intercepts CDP Network.* events and stores them per-page for later querying.
 * Designed to work independently of session/tab-group isolation features.
 */

// ============================================================================
// Types
// ============================================================================

export interface NetworkTiming {
  requestTime: number;
  proxyStart: number;
  proxyEnd: number;
  dnsStart: number;
  dnsEnd: number;
  connectStart: number;
  connectEnd: number;
  sslStart: number;
  sslEnd: number;
  workerStart: number;
  workerReady: number;
  workerFetchStart: number;
  workerRespondWithSettled: number;
  sendStart: number;
  sendEnd: number;
  pushStart: number;
  pushEnd: number;
  receiveHeadersStart: number;
  receiveHeadersEnd: number;
}

export interface NetworkRequest {
  id: string; // CDP requestId
  timestamp: number; // Unix timestamp ms
  method: string;
  url: string;
  resourceType: string;
  documentURL?: string;
  requestHeaders?: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;

  // Response data (filled in on response)
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
  encodedDataLength?: number;

  // Timing (filled in on loadingFinished)
  timing?: NetworkTiming;

  // Body - stored for small text responses, null means "fetch on demand"
  responseBody?: string | null;
  responseBodyBase64?: string | null;

  // State
  completed: boolean;
  failed: boolean;
  failureReason?: string;
}

export interface NetworkFilter {
  url?: string; // Substring match
  method?: string; // Exact match (GET, POST, etc.)
  status?: number; // Exact match
  statusMin?: number; // Range match
  statusMax?: number;
  resourceType?: string; // Exact match (Document, XHR, Fetch, etc.)
  failed?: boolean;
  hasResponseBody?: boolean;
}

export interface NetworkSearchOptions {
  filter?: NetworkFilter;
  sortBy?: "timestamp" | "duration" | "size" | "status";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface NetworkSearchResult {
  total: number;
  requests: NetworkRequestSummary[];
}

export interface NetworkRequestSummary {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  resourceType: string;
  encodedDataLength?: number;
  duration?: number;
  failed: boolean;
  failureReason?: string;
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_MAX_REQUESTS_PER_PAGE = 1000;
const DEFAULT_BODY_SIZE_THRESHOLD = 100 * 1024; // 100KB
const TEXT_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-www-form-urlencoded",
];

// ============================================================================
// Network Store Implementation
// ============================================================================

export class NetworkStore {
  // pageId -> requestId -> NetworkRequest
  private requests = new Map<string, Map<string, NetworkRequest>>();
  private maxRequestsPerPage: number;
  private bodySizeThreshold: number;

  constructor(options?: { maxRequestsPerPage?: number; bodySizeThreshold?: number }) {
    this.maxRequestsPerPage = options?.maxRequestsPerPage ?? DEFAULT_MAX_REQUESTS_PER_PAGE;
    this.bodySizeThreshold = options?.bodySizeThreshold ?? DEFAULT_BODY_SIZE_THRESHOLD;
  }

  // ============================================================================
  // CDP Event Handlers
  // ============================================================================

  /**
   * Handle Network.requestWillBeSent event
   */
  handleRequestWillBeSent(
    pageId: string,
    params: {
      requestId: string;
      documentURL?: string;
      request: {
        url: string;
        method: string;
        headers: Record<string, string>;
        postData?: string;
        hasPostData?: boolean;
      };
      timestamp: number;
      type?: string;
    }
  ): void {
    const pageRequests = this.getOrCreatePageRequests(pageId);

    // Evict oldest if at limit
    if (pageRequests.size >= this.maxRequestsPerPage) {
      const oldest = this.findOldestRequest(pageRequests);
      if (oldest) {
        pageRequests.delete(oldest);
      }
    }

    const request: NetworkRequest = {
      id: params.requestId,
      timestamp: params.timestamp * 1000, // CDP uses seconds, convert to ms
      method: params.request.method,
      url: params.request.url,
      resourceType: params.type ?? "Other",
      documentURL: params.documentURL,
      requestHeaders: params.request.headers,
      postData: params.request.postData,
      hasPostData: params.request.hasPostData,
      completed: false,
      failed: false,
    };

    pageRequests.set(params.requestId, request);
  }

  /**
   * Handle Network.responseReceived event
   */
  handleResponseReceived(
    pageId: string,
    params: {
      requestId: string;
      response: {
        url: string;
        status: number;
        statusText: string;
        headers: Record<string, string>;
        mimeType: string;
        timing?: NetworkTiming;
      };
    }
  ): void {
    const request = this.getRequest(pageId, params.requestId);
    if (!request) return;

    request.status = params.response.status;
    request.statusText = params.response.statusText;
    request.responseHeaders = params.response.headers;
    request.mimeType = params.response.mimeType;
    request.timing = params.response.timing;
  }

  /**
   * Handle Network.loadingFinished event
   */
  handleLoadingFinished(
    pageId: string,
    params: {
      requestId: string;
      timestamp: number;
      encodedDataLength: number;
    }
  ): void {
    const request = this.getRequest(pageId, params.requestId);
    if (!request) return;

    request.completed = true;
    request.encodedDataLength = params.encodedDataLength;
  }

  /**
   * Handle Network.loadingFailed event
   */
  handleLoadingFailed(
    pageId: string,
    params: {
      requestId: string;
      timestamp: number;
      errorText: string;
      canceled?: boolean;
    }
  ): void {
    const request = this.getRequest(pageId, params.requestId);
    if (!request) return;

    request.completed = true;
    request.failed = true;
    request.failureReason = params.canceled ? "Canceled" : params.errorText;
  }

  /**
   * Store response body (called after fetching via Network.getResponseBody)
   */
  storeResponseBody(
    pageId: string,
    requestId: string,
    body: string,
    base64Encoded: boolean
  ): void {
    const request = this.getRequest(pageId, requestId);
    if (!request) return;

    if (base64Encoded) {
      request.responseBodyBase64 = body;
    } else {
      request.responseBody = body;
    }
  }

  /**
   * Check if a request's body should be auto-stored based on content type and size
   */
  shouldAutoStoreBody(pageId: string, requestId: string): boolean {
    const request = this.getRequest(pageId, requestId);
    if (!request) return false;

    // Already have body
    if (request.responseBody !== undefined || request.responseBodyBase64 !== undefined) {
      return false;
    }

    // Check size threshold
    if (request.encodedDataLength && request.encodedDataLength > this.bodySizeThreshold) {
      return false;
    }

    // Check content type
    const mimeType = request.mimeType?.toLowerCase() ?? "";
    return TEXT_CONTENT_TYPES.some((type) => mimeType.includes(type));
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Search requests for a page with filtering, sorting, and pagination
   */
  search(pageId: string, options: NetworkSearchOptions = {}): NetworkSearchResult {
    const pageRequests = this.requests.get(pageId);
    if (!pageRequests) {
      return { total: 0, requests: [] };
    }

    let requests = Array.from(pageRequests.values());

    // Apply filters
    const filter = options.filter ?? {};

    if (filter.url) {
      const term = filter.url.toLowerCase();
      requests = requests.filter((r) => r.url.toLowerCase().includes(term));
    }

    if (filter.method) {
      requests = requests.filter((r) => r.method === filter.method);
    }

    if (filter.status !== undefined) {
      requests = requests.filter((r) => r.status === filter.status);
    }

    if (filter.statusMin !== undefined || filter.statusMax !== undefined) {
      const min = filter.statusMin ?? 0;
      const max = filter.statusMax ?? 999;
      requests = requests.filter((r) => r.status !== undefined && r.status >= min && r.status <= max);
    }

    if (filter.resourceType) {
      requests = requests.filter((r) => r.resourceType === filter.resourceType);
    }

    if (filter.failed === true) {
      requests = requests.filter((r) => r.failed);
    } else if (filter.failed === false) {
      requests = requests.filter((r) => !r.failed);
    }

    if (filter.hasResponseBody === true) {
      requests = requests.filter(
        (r) => r.responseBody !== undefined || r.responseBodyBase64 !== undefined
      );
    }

    // Sort
    const sortBy = options.sortBy ?? "timestamp";
    const sortOrder = options.sortOrder ?? "desc";
    const multiplier = sortOrder === "asc" ? 1 : -1;

    requests.sort((a, b) => {
      switch (sortBy) {
        case "timestamp":
          return (a.timestamp - b.timestamp) * multiplier;
        case "duration":
          return (this.getDuration(a) - this.getDuration(b)) * multiplier;
        case "size":
          return ((a.encodedDataLength ?? 0) - (b.encodedDataLength ?? 0)) * multiplier;
        case "status":
          return ((a.status ?? 0) - (b.status ?? 0)) * multiplier;
        default:
          return 0;
      }
    });

    const total = requests.length;

    // Paginate
    const limit = Math.min(Math.max(1, options.limit ?? 50), 100);
    const offset = Math.max(0, options.offset ?? 0);
    const paginated = requests.slice(offset, offset + limit);

    // Convert to summaries
    const summaries: NetworkRequestSummary[] = paginated.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      method: r.method,
      url: r.url,
      status: r.status,
      statusText: r.statusText,
      resourceType: r.resourceType,
      encodedDataLength: r.encodedDataLength,
      duration: this.getDuration(r),
      failed: r.failed,
      failureReason: r.failureReason,
    }));

    return { total, requests: summaries };
  }

  /**
   * Get full details for a specific request
   */
  getDetail(pageId: string, requestId: string): NetworkRequest | null {
    return this.getRequest(pageId, requestId) ?? null;
  }

  /**
   * Get all request IDs for a page (for on-demand body fetching)
   */
  getRequestIds(pageId: string): string[] {
    const pageRequests = this.requests.get(pageId);
    if (!pageRequests) return [];
    return Array.from(pageRequests.keys());
  }

  /**
   * Clear all requests for a page
   */
  clear(pageId: string): void {
    this.requests.delete(pageId);
  }

  /**
   * Clear all requests
   */
  clearAll(): void {
    this.requests.clear();
  }

  /**
   * Get statistics
   */
  getStats(): { pageCount: number; totalRequests: number } {
    let totalRequests = 0;
    for (const pageRequests of this.requests.values()) {
      totalRequests += pageRequests.size;
    }
    return { pageCount: this.requests.size, totalRequests };
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private getOrCreatePageRequests(pageId: string): Map<string, NetworkRequest> {
    let pageRequests = this.requests.get(pageId);
    if (!pageRequests) {
      pageRequests = new Map();
      this.requests.set(pageId, pageRequests);
    }
    return pageRequests;
  }

  private getRequest(pageId: string, requestId: string): NetworkRequest | undefined {
    return this.requests.get(pageId)?.get(requestId);
  }

  private findOldestRequest(pageRequests: Map<string, NetworkRequest>): string | null {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, request] of pageRequests) {
      if (request.timestamp < oldestTime) {
        oldestTime = request.timestamp;
        oldestId = id;
      }
    }

    return oldestId;
  }

  private getDuration(request: NetworkRequest): number {
    if (!request.timing) return 0;

    // Calculate total duration from timing info
    // requestTime is in seconds since epoch, other values are ms offsets
    const receiveEnd = request.timing.receiveHeadersEnd ?? 0;
    return receiveEnd > 0 ? receiveEnd : 0;
  }
}
