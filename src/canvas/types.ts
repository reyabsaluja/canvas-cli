// Raw Canvas API response types — only the fields we use

export interface CanvasCourse {
  id: number;
  name: string;
  course_code: string;
  enrollment_term_id: number;
  workflow_state: string;
  start_at: string | null;
  end_at: string | null;
  term?: {
    id: number;
    name: string;
    start_at: string | null;
    end_at: string | null;
  };
  enrollments?: Array<{
    enrollment_state: string;
    type: string;
  }>;
}

export interface CanvasSubmission {
  workflow_state: string;
  submitted_at: string | null;
  score: number | null;
  grade: string | null;
  attempt: number | null;
  late: boolean;
  missing: boolean;
}

export interface CanvasAssignment {
  id: number;
  name: string;
  due_at: string | null;
  html_url: string;
  course_id: number;
  has_submitted_submissions: boolean;
  submission?: CanvasSubmission;
}

/** Extended assignment fields returned when fetching a single assignment. */
export interface CanvasAssignmentDetail extends CanvasAssignment {
  description: string | null;
  unlock_at: string | null;
  lock_at: string | null;
  points_possible: number | null;
  grading_type: string;
  submission_types: string[];
  allowed_extensions: string[] | null;
  attachments?: Array<{
    id: number;
    display_name: string;
    filename: string;
    url: string;
    content_type: string;
    size: number;
  }>;
}
