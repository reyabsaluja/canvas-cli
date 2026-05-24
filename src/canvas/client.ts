import type { Config } from "../config/env.js";
import { CanvasApiError } from "./errors.js";
import {
  CanvasCliError,
  CanvasNetworkError,
  CanvasRateLimitError,
  CanvasServerError,
  classifyError,
  isAbortError,
  isNetworkError,
} from "../errors.js";
import { debugApiRequest, debugApiResponse, maskUrl } from "../debug.js";
import { fetchWithRetry, type RetryOptions, RateLimitThrottle } from "./retry.js";
import type {
  CanvasAssignment,
  CanvasAssignmentDetail,
  CanvasCourse,
  CanvasCourseDetail,
  CanvasDiscussionTopic,
  CanvasDiscussionTopicView,
  CanvasFile,
  CanvasModule,
  CanvasModuleItem,
  CanvasPage,
} from "./types.js";

export class CanvasClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private retryOptions?: RetryOptions;
  private _skippedEndpoints: string[] = [];
  private throttle: RateLimitThrottle;

  constructor(config: Config, retryOptions?: RetryOptions) {
    this.baseUrl = config.baseUrl;
    this.headers = {
      Authorization: `Bearer ${config.accessToken}`,
      Accept: "application/json",
    };
    this.throttle = new RateLimitThrottle({
      log: retryOptions?.log,
      sleepFn: retryOptions?.sleepFn,
    });
    this.retryOptions = { ...retryOptions, throttle: this.throttle };
  }

  get skippedEndpoints(): readonly string[] {
    return this._skippedEndpoints;
  }

  resetSkippedEndpoints(): void {
    this._skippedEndpoints = [];
  }

  private async fetchPaginated<T>(url: string, signal?: AbortSignal | null): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = url;

    while (nextUrl) {
      debugApiRequest("GET", nextUrl);
      const start = Date.now();
      let response: Response;
      try {
        response = await fetchWithRetry(
          nextUrl,
          { headers: this.headers, signal: signal ?? undefined },
          this.retryOptions
        );
      } catch (err) {
        throw this.toNetworkError(err);
      }
      debugApiResponse("GET", nextUrl, response.status, Date.now() - start);

      if (!response.ok) {
        this.throwForStatus(response);
      }

      const data = (await response.json()) as T[];
      results.push(...data);

      nextUrl = this.parseNextLink(response.headers.get("link"));
    }

    return results;
  }

  private async fetchOne<T>(url: string, signal?: AbortSignal | null): Promise<T> {
    debugApiRequest("GET", url);
    const start = Date.now();
    let response: Response;
    try {
      response = await fetchWithRetry(
        url,
        { headers: this.headers, signal: signal ?? undefined },
        this.retryOptions
      );
    } catch (err) {
      throw this.toNetworkError(err);
    }
    debugApiResponse("GET", url, response.status, Date.now() - start);

    if (!response.ok) {
      this.throwForStatus(response);
    }

    return (await response.json()) as T;
  }

  private throwForStatus(response: Response): never {
    const { status, statusText } = response;
    const apiErr = new CanvasApiError(status, statusText);
    if (status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
      const retryMs = Number.isFinite(parsed) ? parsed * 1000 : null;
      throw new CanvasRateLimitError(retryMs, apiErr);
    }
    throw classifyError(apiErr);
  }

  private toNetworkError(err: unknown): Error {
    if (isNetworkError(err)) {
      return new CanvasNetworkError(undefined, err);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private parseNextLink(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    const parts = linkHeader.split(",");
    for (const part of parts) {
      const match = part.match(/<([^>]+)>/);
      if (match && /rel="next"/.test(part)) {
        return match[1] ?? null;
      }
    }
    return null;
  }

  /** Get courses with term and enrollment info for relevance filtering. */
  async getCourses(signal?: AbortSignal | null): Promise<CanvasCourse[]> {
    const url = `${this.baseUrl}/courses?per_page=50&include[]=term&include[]=total_students&include[]=enrollments`;
    return this.fetchPaginated<CanvasCourse>(url, signal);
  }

  /** Get assignments for a course, including submission status. */
  async getAssignments(courseId: number, signal?: AbortSignal | null): Promise<CanvasAssignment[]> {
    const url = `${this.baseUrl}/courses/${courseId}/assignments?per_page=50&include[]=submission`;
    return this.fetchPaginated<CanvasAssignment>(url, signal);
  }

  /** Get full detail for a single assignment. */
  async getAssignmentDetail(
    courseId: number,
    assignmentId: number,
    signal?: AbortSignal | null
  ): Promise<CanvasAssignmentDetail> {
    const url = `${this.baseUrl}/courses/${courseId}/assignments/${assignmentId}?include[]=submission&include[]=rubric`;
    return this.fetchOne<CanvasAssignmentDetail>(url, signal);
  }

  /** Get course detail with syllabus body. */
  async getCourseDetail(courseId: number, signal?: AbortSignal | null): Promise<CanvasCourseDetail> {
    const url = `${this.baseUrl}/courses/${courseId}?include[]=syllabus_body&include[]=term`;
    return this.fetchOne<CanvasCourseDetail>(url, signal);
  }

  /**
   * Get the course front page (home page) content. Returns null if not available.
   */
  async getFrontPageSafe(courseId: number, signal?: AbortSignal | null): Promise<{ title: string; body: string } | null> {
    try {
      const url = `${this.baseUrl}/courses/${courseId}/front_page`;
      const page = await this.fetchOne<{ title: string; body: string }>(url, signal);
      return page?.body ? page : null;
    } catch (err) {
      if (isAbortError(err)) throw err;
      return null;
    }
  }

  /**
   * Get a specific page by slug. Returns null if not accessible.
   */
  async getPageBySlugSafe(courseId: number, slug: string, signal?: AbortSignal | null): Promise<{ title: string; body: string; url: string } | null> {
    try {
      const url = `${this.baseUrl}/courses/${courseId}/pages/${slug}`;
      const page = await this.fetchOne<{ title: string; body: string; url: string }>(url, signal);
      return page?.body ? page : null;
    } catch (err) {
      if (isAbortError(err)) throw err;
      return null;
    }
  }

  /**
   * Get modules for a course. Returns empty array if modules are disabled/inaccessible.
   */
  async getModulesSafe(courseId: number, signal?: AbortSignal | null): Promise<CanvasModule[]> {
    const url = `${this.baseUrl}/courses/${courseId}/modules?per_page=50`;
    return this.fetchPaginatedSafe<CanvasModule>(url, signal);
  }

  /**
   * Get items for a specific module. Returns empty array on failure.
   */
  async getModuleItemsSafe(
    courseId: number,
    moduleId: number,
    signal?: AbortSignal | null
  ): Promise<CanvasModuleItem[]> {
    const url = `${this.baseUrl}/courses/${courseId}/modules/${moduleId}/items?per_page=50`;
    return this.fetchPaginatedSafe<CanvasModuleItem>(url, signal);
  }

  /**
   * Get files for a course. Returns empty array if the Files API is blocked.
   * Some institutions restrict student access to the files endpoint.
   */
  async getFilesSafe(courseId: number, signal?: AbortSignal | null): Promise<CanvasFile[]> {
    const url = `${this.baseUrl}/courses/${courseId}/files?per_page=50`;
    return this.fetchPaginatedSafe<CanvasFile>(url, signal);
  }

  /**
   * Get pages for a course. Returns empty array if the Pages API is blocked.
   * Some institutions restrict student access to pages.
   */
  async getPagesSafe(courseId: number, signal?: AbortSignal | null): Promise<CanvasPage[]> {
    const url = `${this.baseUrl}/courses/${courseId}/pages?per_page=50`;
    return this.fetchPaginatedSafe<CanvasPage>(url, signal);
  }

  /**
   * Get a single file's metadata by Canvas file ID.
   * Returns null if the Files API is blocked or file not found.
   */
  async getFileSafe(fileId: number, signal?: AbortSignal | null): Promise<CanvasFile | null> {
    try {
      const url = `${this.baseUrl}/files/${fileId}`;
      return await this.fetchOne<CanvasFile>(url, signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      return null;
    }
  }

  /**
   * Download a file by URL with Canvas auth. Returns the buffer or null on failure.
   */
  async downloadFile(downloadUrl: string): Promise<Buffer | null> {
    try {
      const response = await fetchWithRetry(downloadUrl, {
        headers: this.headers,
        redirect: "follow",
      }, { ...this.retryOptions, requestTimeoutMs: 60_000 });
      if (!response.ok) return null;
      return Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
    }
  }

  async getAnnouncementsForContexts(
    contextCodes: string[],
    options?: { startDate?: string; endDate?: string; latestOnly?: boolean }
  ): Promise<CanvasDiscussionTopic[]> {
    if (contextCodes.length === 0) return [];

    const params = new URLSearchParams();
    for (const contextCode of contextCodes) {
      params.append("context_codes[]", contextCode);
    }
    params.set("per_page", "50");
    if (options?.startDate) params.set("start_date", options.startDate);
    if (options?.endDate) params.set("end_date", options.endDate);
    if (options?.latestOnly) params.set("latest_only", "true");

    const url = `${this.baseUrl}/announcements?${params.toString()}`;
    return this.fetchPaginated<CanvasDiscussionTopic>(url);
  }

  /** Get announcements for a course. Returns empty array on access errors. */
  async getAnnouncementsSafe(
    courseId: number,
    _options?: { startDate?: string; endDate?: string },
    signal?: AbortSignal | null
  ): Promise<CanvasDiscussionTopic[]> {
    const params = new URLSearchParams();
    params.set("only_announcements", "true");
    params.set("per_page", "50");
    params.set("order_by", "recent_activity");
    const url = `${this.baseUrl}/courses/${courseId}/discussion_topics?${params.toString()}`;
    return this.fetchPaginatedSafe<CanvasDiscussionTopic>(url, signal);
  }

  /** Get discussion topics for a course (excludes announcements). Returns empty array on access errors. */
  async getDiscussionTopicsSafe(courseId: number, signal?: AbortSignal | null): Promise<CanvasDiscussionTopic[]> {
    const url = `${this.baseUrl}/courses/${courseId}/discussion_topics?per_page=30&order_by=recent_activity`;
    const topics = await this.fetchPaginatedSafe<CanvasDiscussionTopic>(url, signal);
    return topics.filter((t) => !t.is_announcement);
  }

  /** Search discussion topics by title. Returns empty array on access errors. */
  async searchDiscussionTopicsSafe(
    courseId: number,
    searchTerm: string
  ): Promise<CanvasDiscussionTopic[]> {
    const encoded = encodeURIComponent(searchTerm);
    const url = `${this.baseUrl}/courses/${courseId}/discussion_topics?per_page=10&search_term=${encoded}`;
    return this.fetchPaginatedSafe<CanvasDiscussionTopic>(url);
  }

  /** Get the full thread view for a discussion topic. Returns null on error. */
  async getDiscussionTopicViewSafe(
    courseId: number,
    topicId: number,
    signal?: AbortSignal | null
  ): Promise<CanvasDiscussionTopicView | null> {
    try {
      const url = `${this.baseUrl}/courses/${courseId}/discussion_topics/${topicId}/view?include_new_entries=1`;
      return await this.fetchOne<CanvasDiscussionTopicView>(url, signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      return null;
    }
  }

  /**
   * Like fetchPaginated but returns [] on auth/access/5xx errors instead of throwing.
   * Used for endpoints that may be blocked or temporarily unavailable — after retries
   * are exhausted, we prefer partial data over crashing the entire ingest.
   */
  private async fetchPaginatedSafe<T>(url: string, signal?: AbortSignal | null): Promise<T[]> {
    try {
      return await this.fetchPaginated<T>(url, signal);
    } catch (err) {
      if (err instanceof CanvasCliError && err.kind !== "network" && err.kind !== "unknown") {
        this._skippedEndpoints.push(url);
        if (err instanceof CanvasRateLimitError) {
          console.error(`Warning: rate-limited by Canvas API, skipping: ${url}`);
        } else if (err instanceof CanvasServerError) {
          console.error(`Warning: Canvas API returned ${err.statusCode} after retries, skipping: ${url}`);
        } else {
          console.error(`Warning: Canvas API error (${err.kind}), skipping: ${url}`);
        }
        return [];
      }
      throw err;
    }
  }
}
