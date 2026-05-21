import type { Config } from "../config/env.js";
import { CanvasApiError } from "./errors.js";
import { fetchWithRetry, type RetryOptions } from "./retry.js";
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

  constructor(config: Config, retryOptions?: RetryOptions) {
    this.baseUrl = config.baseUrl;
    this.headers = {
      Authorization: `Bearer ${config.accessToken}`,
      Accept: "application/json",
    };
    this.retryOptions = retryOptions;
  }

  get skippedEndpoints(): readonly string[] {
    return this._skippedEndpoints;
  }

  resetSkippedEndpoints(): void {
    this._skippedEndpoints = [];
  }

  private async fetchPaginated<T>(url: string): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = url;

    while (nextUrl) {
      const response = await fetchWithRetry(nextUrl, { headers: this.headers }, this.retryOptions);

      if (!response.ok) {
        const err = new CanvasApiError(response.status, response.statusText);
        if (err.userHint) err.message += ` — ${err.userHint}`;
        throw err;
      }

      const data = (await response.json()) as T[];
      results.push(...data);

      nextUrl = this.parseNextLink(response.headers.get("link"));
    }

    return results;
  }

  private async fetchOne<T>(url: string): Promise<T> {
    const response = await fetchWithRetry(url, { headers: this.headers }, this.retryOptions);

    if (!response.ok) {
      const err = new CanvasApiError(response.status, response.statusText);
      if (err.userHint) err.message += ` — ${err.userHint}`;
      throw err;
    }

    return (await response.json()) as T;
  }

  private parseNextLink(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return match ? match[1] : null;
  }

  /** Get courses with term and enrollment info for relevance filtering. */
  async getCourses(): Promise<CanvasCourse[]> {
    const url = `${this.baseUrl}/courses?per_page=50&include[]=term&include[]=total_students&include[]=enrollments`;
    return this.fetchPaginated<CanvasCourse>(url);
  }

  /** Get assignments for a course, including submission status. */
  async getAssignments(courseId: number): Promise<CanvasAssignment[]> {
    const url = `${this.baseUrl}/courses/${courseId}/assignments?per_page=50&include[]=submission`;
    return this.fetchPaginated<CanvasAssignment>(url);
  }

  /** Get full detail for a single assignment. */
  async getAssignmentDetail(
    courseId: number,
    assignmentId: number
  ): Promise<CanvasAssignmentDetail> {
    const url = `${this.baseUrl}/courses/${courseId}/assignments/${assignmentId}?include[]=submission&include[]=rubric`;
    return this.fetchOne<CanvasAssignmentDetail>(url);
  }

  /** Get course detail with syllabus body. */
  async getCourseDetail(courseId: number): Promise<CanvasCourseDetail> {
    const url = `${this.baseUrl}/courses/${courseId}?include[]=syllabus_body&include[]=term`;
    return this.fetchOne<CanvasCourseDetail>(url);
  }

  /**
   * Get the course front page (home page) content. Returns null if not available.
   */
  async getFrontPageSafe(courseId: number): Promise<{ title: string; body: string } | null> {
    try {
      const url = `${this.baseUrl}/courses/${courseId}/front_page`;
      const page = await this.fetchOne<{ title: string; body: string }>(url);
      return page?.body ? page : null;
    } catch {
      return null;
    }
  }

  /**
   * Get a specific page by slug. Returns null if not accessible.
   */
  async getPageBySlugSafe(courseId: number, slug: string): Promise<{ title: string; body: string; url: string } | null> {
    try {
      const url = `${this.baseUrl}/courses/${courseId}/pages/${slug}`;
      const page = await this.fetchOne<{ title: string; body: string; url: string }>(url);
      return page?.body ? page : null;
    } catch {
      return null;
    }
  }

  /**
   * Get modules for a course. Returns empty array if modules are disabled/inaccessible.
   */
  async getModulesSafe(courseId: number): Promise<CanvasModule[]> {
    const url = `${this.baseUrl}/courses/${courseId}/modules?per_page=50`;
    return this.fetchPaginatedSafe<CanvasModule>(url);
  }

  /**
   * Get items for a specific module. Returns empty array on failure.
   */
  async getModuleItemsSafe(
    courseId: number,
    moduleId: number
  ): Promise<CanvasModuleItem[]> {
    const url = `${this.baseUrl}/courses/${courseId}/modules/${moduleId}/items?per_page=50`;
    return this.fetchPaginatedSafe<CanvasModuleItem>(url);
  }

  /**
   * Get files for a course. Returns empty array if the Files API is blocked.
   * Some institutions restrict student access to the files endpoint.
   */
  async getFilesSafe(courseId: number): Promise<CanvasFile[]> {
    const url = `${this.baseUrl}/courses/${courseId}/files?per_page=50`;
    return this.fetchPaginatedSafe<CanvasFile>(url);
  }

  /**
   * Get pages for a course. Returns empty array if the Pages API is blocked.
   * Some institutions restrict student access to pages.
   */
  async getPagesSafe(courseId: number): Promise<CanvasPage[]> {
    const url = `${this.baseUrl}/courses/${courseId}/pages?per_page=50`;
    return this.fetchPaginatedSafe<CanvasPage>(url);
  }

  /**
   * Get a single file's metadata by Canvas file ID.
   * Returns null if the Files API is blocked or file not found.
   */
  async getFileSafe(fileId: number): Promise<CanvasFile | null> {
    try {
      const url = `${this.baseUrl}/files/${fileId}`;
      return await this.fetchOne<CanvasFile>(url);
    } catch {
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
      }, this.retryOptions);
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
    _options?: { startDate?: string; endDate?: string }
  ): Promise<CanvasDiscussionTopic[]> {
    const params = new URLSearchParams();
    params.set("only_announcements", "true");
    params.set("per_page", "50");
    params.set("order_by", "recent_activity");
    const url = `${this.baseUrl}/courses/${courseId}/discussion_topics?${params.toString()}`;
    return this.fetchPaginatedSafe<CanvasDiscussionTopic>(url);
  }

  /** Get discussion topics for a course (excludes announcements). Returns empty array on access errors. */
  async getDiscussionTopicsSafe(courseId: number): Promise<CanvasDiscussionTopic[]> {
    const url = `${this.baseUrl}/courses/${courseId}/discussion_topics?per_page=30&order_by=recent_activity`;
    const topics = await this.fetchPaginatedSafe<CanvasDiscussionTopic>(url);
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
    topicId: number
  ): Promise<CanvasDiscussionTopicView | null> {
    try {
      const url = `${this.baseUrl}/courses/${courseId}/discussion_topics/${topicId}/view?include_new_entries=1`;
      return await this.fetchOne<CanvasDiscussionTopicView>(url);
    } catch {
      return null;
    }
  }

  /**
   * Like fetchPaginated but returns [] on auth/access/5xx errors instead of throwing.
   * Used for endpoints that may be blocked or temporarily unavailable — after retries
   * are exhausted, we prefer partial data over crashing the entire ingest.
   */
  private async fetchPaginatedSafe<T>(url: string): Promise<T[]> {
    try {
      return await this.fetchPaginated<T>(url);
    } catch (err) {
      if (err instanceof CanvasApiError) {
        const s = err.status;
        if (s === 401 || s === 403 || s === 404 || (s >= 500 && s < 600)) {
          this._skippedEndpoints.push(url);
          if (s >= 500) {
            console.error(`Warning: Canvas API returned ${s} after retries, skipping: ${url}`);
          }
          return [];
        }
      }
      throw err;
    }
  }
}
