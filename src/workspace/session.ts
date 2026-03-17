export interface SessionMeta {
  version: 1;
  createdAt: string;
  updatedAt: string;
  sessionSlug: string;
  workspacePath: string;
  assignmentId: number;
  assignmentName: string;
  courseId: number;
  courseName: string;
  courseCode: string;
}
