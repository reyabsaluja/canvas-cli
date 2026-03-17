import type { Config } from "../config/env.js";
import type {
  CanvasAssignment,
  CanvasAssignmentDetail,
  CanvasCourse,
} from "./types.js";

export class CanvasClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: Config) {
    this.baseUrl = config.baseUrl;
    this.headers = {
      Authorization: `Bearer ${config.accessToken}`,
      Accept: "application/json",
    };
  }

  private async fetchPaginated<T>(url: string): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = url;

    while (nextUrl) {
      const response = await fetch(nextUrl, { headers: this.headers });

      if (response.status === 401) {
        throw new Error(
          "Canvas API returned 401 Unauthorized. Check your CANVAS_ACCESS_TOKEN."
        );
      }
      if (!response.ok) {
        throw new Error(
          `Canvas API error: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as T[];
      results.push(...data);

      nextUrl = this.parseNextLink(response.headers.get("link"));
    }

    return results;
  }

  private async fetchOne<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers: this.headers });

    if (response.status === 401) {
      throw new Error(
        "Canvas API returned 401 Unauthorized. Check your CANVAS_ACCESS_TOKEN."
      );
    }
    if (response.status === 404) {
      throw new Error("Assignment not found on Canvas.");
    }
    if (!response.ok) {
      throw new Error(
        `Canvas API error: ${response.status} ${response.statusText}`
      );
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
    const url = `${this.baseUrl}/courses/${courseId}/assignments/${assignmentId}?include[]=submission`;
    return this.fetchOne<CanvasAssignmentDetail>(url);
  }
}
