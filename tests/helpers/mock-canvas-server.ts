import http from "node:http";

export interface MockCourse {
  id: number;
  name: string;
  course_code: string;
  enrollment_term_id: number;
  workflow_state: string;
  start_at: string | null;
  end_at: string | null;
  term?: { id: number; name: string; start_at: string | null; end_at: string | null };
  enrollments?: Array<{ enrollment_state: string; type: string }>;
}

export interface MockAssignment {
  id: number;
  name: string;
  due_at: string | null;
  html_url: string;
  course_id: number;
  has_submitted_submissions: boolean;
  description?: string | null;
  points_possible?: number | null;
  submission_types?: string[];
  submission?: {
    workflow_state: string;
    submitted_at: string | null;
    score: number | null;
    grade: string | null;
    attempt: number | null;
    late: boolean;
    missing: boolean;
  };
}

export interface MockModule {
  id: number;
  name: string;
  position: number;
  items_count: number;
  items_url: string;
  items?: Array<{
    id: number;
    title: string;
    type: string;
    position: number;
    content_id?: number;
    page_url?: string;
    html_url?: string;
    external_url?: string;
  }>;
}

export interface MockPage {
  page_id: number;
  url: string;
  title: string;
  html_url: string | null;
  updated_at: string | null;
  body?: string | null;
}

export interface MockFile {
  id: number;
  display_name: string;
  filename: string;
  content_type: string;
  size: number;
  url: string;
  updated_at: string | null;
  folder_id: number | null;
}

export interface MockFolder {
  id: number;
  name: string;
  full_name: string;
  parent_folder_id: number | null;
  files_count?: number;
  folders_count?: number;
}

export interface MockServerData {
  courses: MockCourse[];
  assignments: Map<number, MockAssignment[]>;
  modules: Map<number, MockModule[]>;
  pages: Map<number, MockPage[]>;
  files: Map<number, MockFile[]>;
  /** Folder tree served from GET /courses/:id/folders. */
  folders?: Map<number, MockFolder[]>;
  /** Bytes served from GET /files/:id/download (defaults to a short text body). */
  fileContents?: Map<number, string>;
  /** Any API path matching one of these returns 403, to simulate institution blocks. */
  forbiddenPaths?: RegExp[];
  courseDetails: Map<number, { syllabus_body: string | null }>;
  pagePerPage?: number;
}

function parseLinkParams(url: URL): { page: number; perPage: number } {
  const page = parseInt(url.searchParams.get("page") ?? "1", 10);
  const perPage = parseInt(url.searchParams.get("per_page") ?? "10", 10);
  return { page, perPage };
}

function paginatedResponse(
  items: unknown[],
  page: number,
  perPage: number,
  baseUrl: string,
  path: string
): { body: string; headers: Record<string, string> } {
  const start = (page - 1) * perPage;
  const end = start + perPage;
  const slice = items.slice(start, end);
  const totalPages = Math.ceil(items.length / perPage);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (totalPages > 1) {
    const links: string[] = [];
    if (page < totalPages) {
      links.push(`<${baseUrl}${path}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
    }
    links.push(`<${baseUrl}${path}?page=${totalPages}&per_page=${perPage}>; rel="last"`);
    if (page > 1) {
      links.push(`<${baseUrl}${path}?page=1&per_page=${perPage}>; rel="first"`);
    }
    headers["Link"] = links.join(", ");
  }

  return { body: JSON.stringify(slice), headers };
}

export function createMockCanvasServer(data: MockServerData): http.Server {
  const server = http.createServer((req, res) => {
    // Mirror the client's origin (Host header) in Link headers, like real Canvas
    // does; the client refuses to follow pagination links to a different origin.
    const port = (server.address() as { port: number })?.port ?? 0;
    const host = req.headers.host || `localhost:${port}`;
    const baseApiUrl = `http://${host}/api/v1`;

    const url = new URL(req.url ?? "/", `http://localhost`);
    const path = url.pathname.replace(/^\/api\/v1/, "");

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "Invalid access token." }] }));
      return;
    }

    const token = authHeader.slice(7);
    if (token === "expired-token") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "Invalid access token." }] }));
      return;
    }

    if (token === "forbidden-token") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "user not authorized" }] }));
      return;
    }

    if (data.forbiddenPaths?.some((pattern) => pattern.test(path))) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "user not authorized" }] }));
      return;
    }

    const { page, perPage } = parseLinkParams(url);
    const effectivePerPage = data.pagePerPage ?? perPage;

    // GET /courses
    if (path === "/courses" && req.method === "GET") {
      const { body, headers } = paginatedResponse(
        data.courses,
        page,
        effectivePerPage,
        baseApiUrl,
        "/courses"
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id
    const courseDetailMatch = path.match(/^\/courses\/(\d+)$/);
    if (courseDetailMatch && req.method === "GET") {
      const courseId = parseInt(courseDetailMatch[1], 10);
      const course = data.courses.find((c) => c.id === courseId);
      if (!course) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "The specified resource does not exist" }] }));
        return;
      }
      const detail = data.courseDetails.get(courseId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...course, syllabus_body: detail?.syllabus_body ?? null }));
      return;
    }

    // GET /courses/:id/assignments
    const assignmentsMatch = path.match(/^\/courses\/(\d+)\/assignments$/);
    if (assignmentsMatch && req.method === "GET") {
      const courseId = parseInt(assignmentsMatch[1], 10);
      const assignments = data.assignments.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(
        assignments,
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/assignments`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/assignments/:aid
    const assignmentDetailMatch = path.match(/^\/courses\/(\d+)\/assignments\/(\d+)$/);
    if (assignmentDetailMatch && req.method === "GET") {
      const courseId = parseInt(assignmentDetailMatch[1], 10);
      const assignmentId = parseInt(assignmentDetailMatch[2], 10);
      const assignments = data.assignments.get(courseId) ?? [];
      const assignment = assignments.find((a) => a.id === assignmentId);
      if (!assignment) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "The specified resource does not exist" }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(assignment));
      return;
    }

    // GET /courses/:id/modules
    const modulesMatch = path.match(/^\/courses\/(\d+)\/modules$/);
    if (modulesMatch && req.method === "GET") {
      const courseId = parseInt(modulesMatch[1], 10);
      const modules = data.modules.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(
        modules.map(({ items: _items, ...m }) => m),
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/modules`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/modules/:mid/items
    const moduleItemsMatch = path.match(/^\/courses\/(\d+)\/modules\/(\d+)\/items$/);
    if (moduleItemsMatch && req.method === "GET") {
      const courseId = parseInt(moduleItemsMatch[1], 10);
      const moduleId = parseInt(moduleItemsMatch[2], 10);
      const modules = data.modules.get(courseId) ?? [];
      const mod = modules.find((m) => m.id === moduleId);
      const items = mod?.items ?? [];
      const { body, headers } = paginatedResponse(
        items,
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/modules/${moduleId}/items`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/pages
    const pagesMatch = path.match(/^\/courses\/(\d+)\/pages$/);
    if (pagesMatch && req.method === "GET") {
      const courseId = parseInt(pagesMatch[1], 10);
      const pages = data.pages.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(
        pages.map(({ body: _body, ...p }) => p),
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/pages`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/pages/:slug
    const pageSlugMatch = path.match(/^\/courses\/(\d+)\/pages\/([^/]+)$/);
    if (pageSlugMatch && req.method === "GET") {
      const courseId = parseInt(pageSlugMatch[1], 10);
      const slug = pageSlugMatch[2];
      const pages = data.pages.get(courseId) ?? [];
      const foundPage = pages.find((p) => p.url === slug);
      if (!foundPage) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "The specified resource does not exist" }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(foundPage));
      return;
    }

    // GET /courses/:id/front_page
    const frontPageMatch = path.match(/^\/courses\/(\d+)\/front_page$/);
    if (frontPageMatch && req.method === "GET") {
      const courseId = parseInt(frontPageMatch[1], 10);
      const pages = data.pages.get(courseId) ?? [];
      const frontPage = pages.find((p) => p.url === "front-page");
      if (!frontPage) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(frontPage));
      return;
    }

    // GET /courses/:id/files
    const filesMatch = path.match(/^\/courses\/(\d+)\/files$/);
    if (filesMatch && req.method === "GET") {
      const courseId = parseInt(filesMatch[1], 10);
      const files = data.files.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(
        files,
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/files`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/folders
    const foldersMatch = path.match(/^\/courses\/(\d+)\/folders$/);
    if (foldersMatch && req.method === "GET") {
      const courseId = parseInt(foldersMatch[1], 10);
      const folders = data.folders?.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(
        folders,
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/folders`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /files/:id/download (also reachable without the /api/v1 prefix)
    const fileDownloadMatch = path.match(/^\/files\/(\d+)\/download$/);
    if (fileDownloadMatch && req.method === "GET") {
      const fileId = parseInt(fileDownloadMatch[1], 10);
      let found: MockFile | undefined;
      for (const files of data.files.values()) {
        found = files.find((f) => f.id === fileId);
        if (found) break;
      }
      if (!found) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
        return;
      }
      const content =
        data.fileContents?.get(fileId) ?? `mock content of ${found.filename}\n`;
      res.writeHead(200, {
        "Content-Type": found.content_type,
        "Content-Length": String(Buffer.byteLength(content)),
      });
      res.end(content);
      return;
    }

    // GET /courses/:id/discussion_topics
    const discussionMatch = path.match(/^\/courses\/(\d+)\/discussion_topics$/);
    if (discussionMatch && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    // GET /announcements
    if (path === "/announcements" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    // GET /files/:id
    const fileByIdMatch = path.match(/^\/files\/(\d+)$/);
    if (fileByIdMatch && req.method === "GET") {
      const fileId = parseInt(fileByIdMatch[1], 10);
      for (const files of data.files.values()) {
        const file = files.find((f) => f.id === fileId);
        if (file) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(file));
          return;
        }
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
      return;
    }

    // Fallback: 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errors: [{ message: "endpoint not found" }] }));
  });

  return server;
}

export function startServer(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}

export function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
