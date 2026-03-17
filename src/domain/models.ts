export interface Course {
  id: number;
  name: string;
  courseCode: string;
  termName: string | null;
  isCurrent: boolean;
}

export type AssignmentStatus = "overdue" | "upcoming" | "submitted" | "no_date";

export interface Assignment {
  id: number;
  name: string;
  courseId: number;
  courseName: string;
  dueAt: Date | null;
  submitted: boolean;
  status: AssignmentStatus;
  htmlUrl: string;
}

export interface AssignmentDetail extends Assignment {
  description: string | null;
  unlockAt: Date | null;
  lockAt: Date | null;
  pointsPossible: number | null;
  gradingType: string;
  submissionTypes: string[];
  allowedExtensions: string[] | null;
  submittedAt: Date | null;
  score: number | null;
  grade: string | null;
  late: boolean;
  missing: boolean;
  attachments: AssignmentAttachment[];
}

export interface AssignmentAttachment {
  id: number;
  displayName: string;
  filename: string;
  url: string;
  contentType: string;
  size: number;
}
