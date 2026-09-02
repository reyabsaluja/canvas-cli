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
  public_description?: string | null;
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
  unlock_at?: string | null;
  lock_at?: string | null;
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
  rubric?: CanvasRubricCriterion[] | null;
  attachments?: Array<{
    id: number;
    display_name: string;
    filename: string;
    url: string;
    content_type: string;
    size: number;
  }>;
}

export interface CanvasRubricCriterion {
  id: string | number;
  description: string;
  long_description?: string | null;
  points: number | null;
  criterion_use_range?: boolean;
  ratings?: CanvasRubricRating[] | null;
}

export interface CanvasRubricRating {
  id?: string | number;
  description: string;
  long_description?: string | null;
  points?: number | null;
}

/** Course with syllabus body included. */
export interface CanvasCourseDetail extends CanvasCourse {
  syllabus_body: string | null;
  html_url?: string;
}

export interface CanvasModule {
  id: number;
  name: string;
  position: number;
  items_count: number;
  items_url: string;
}

export interface CanvasModuleItem {
  id: number;
  title: string;
  type: string;
  position: number;
  content_id?: number;
  page_url?: string;
  html_url?: string;
  external_url?: string;
  url?: string; // API URL to the resource
}

export interface CanvasFile {
  id: number;
  display_name: string;
  filename: string;
  content_type: string;
  size: number;
  url: string;
  updated_at: string | null;
  folder_id: number | null;
}

export interface CanvasPage {
  page_id: number;
  url: string; // slug used as page identifier
  title: string;
  html_url: string | null;
  updated_at: string | null;
  body?: string | null;
}

export interface CanvasAssignmentGroup {
  id: number;
  name: string;
  group_weight: number;
  assignments?: CanvasAssignmentGroupAssignment[];
}

export interface CanvasAssignmentGroupAssignment {
  id: number;
  name: string;
  due_at: string | null;
  points_possible: number | null;
  omit_from_final_grade: boolean;
  submission?: CanvasSubmission;
}

export interface CanvasEnrollment {
  course_id: number;
  type: string;
  enrollment_state: string;
  computed_current_score: number | null;
  computed_current_grade: string | null;
  computed_final_score: number | null;
  computed_final_grade: string | null;
  grades?: {
    current_score: number | null;
    current_grade: string | null;
    final_score: number | null;
    final_grade: string | null;
  };
}

/** A discussion topic or announcement from the Canvas API. */
export interface CanvasDiscussionTopic {
  id: number;
  title: string;
  message: string | null;
  context_code?: string | null;
  posted_at: string | null;
  last_reply_at: string | null;
  discussion_type: string;
  read_state: string;
  unread_count: number;
  user_name: string | null;
  html_url: string;
  published: boolean;
  is_announcement: boolean;
  locked: boolean;
}

/** A single entry (reply) within a discussion topic. */
export interface CanvasDiscussionEntry {
  id: number;
  user_id: number;
  user_name: string | null;
  message: string | null;
  created_at: string;
  updated_at: string;
  read_state: string;
  recent_replies?: CanvasDiscussionEntry[];
  has_more_replies?: boolean;
}

/** Full topic view returned by GET /discussion_topics/:id/view. */
export interface CanvasDiscussionTopicView {
  participants: Array<{ id: number; display_name: string }>;
  unread_entries: number[];
  view: CanvasDiscussionEntry[];
  new_entries: CanvasDiscussionEntry[];
}

/** A folder in a course's Files area (GET /courses/:id/folders). */
export interface CanvasFolder {
  id: number;
  name: string;
  /** Full path from the root, e.g. "course files/Lectures/Week 1". */
  full_name: string;
  parent_folder_id: number | null;
  files_count?: number | null;
  folders_count?: number | null;
  hidden?: boolean | null;
  locked?: boolean | null;
}
