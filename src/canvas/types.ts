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

/**
 * A file attached to a discussion topic, announcement, or reply through the
 * Canvas "Attach" button. Canvas serialises the MIME type as `content-type`
 * (hyphenated) on these records; `content_type` is accepted for fixtures and
 * older instances.
 */
export interface CanvasTopicAttachment {
  id: number;
  display_name?: string | null;
  filename?: string | null;
  "content-type"?: string | null;
  content_type?: string | null;
  size?: number | null;
  url: string;
  locked_for_user?: boolean;
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
  /** Files attached to the post itself (not linked from `message`). */
  attachments?: CanvasTopicAttachment[] | null;
}

/**
 * A single entry (reply) within a discussion topic.
 *
 * Two endpoints produce these with different shapes: GET .../view nests
 * threaded children under `replies`, carries `parent_id` and `deleted`, and
 * omits `user_name` (names live in the view's `participants`); GET .../entries
 * and .../replies return `user_name` plus up to 10 `recent_replies` and set
 * `has_more_replies` when the inline list is truncated.
 */
export interface CanvasDiscussionEntry {
  id: number;
  user_id: number;
  user_name?: string | null;
  parent_id?: number | null;
  message: string | null;
  created_at: string;
  updated_at: string;
  read_state?: string;
  /** Set on tombstones left behind when an entry was deleted (no message). */
  deleted?: boolean;
  /** File attached to this reply (Canvas allows one per entry). */
  attachment?: CanvasTopicAttachment | null;
  /** Threaded children as returned by GET .../view. */
  replies?: CanvasDiscussionEntry[];
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
/** A course navigation tab from GET /courses/:id/tabs (external tools show as type "external"). */
export interface CanvasTab {
  id: string;
  label: string;
  html_url?: string | null;
  /** Launch URL for external tools (LTI), e.g. Piazza, Zoom, Ed. */
  full_url?: string | null;
  type?: "internal" | "external" | string | null;
  hidden?: boolean | null;
  visibility?: string | null;
  position?: number | null;
}

/** A classic or New Quiz as listed by GET /courses/:id/quizzes. */
export interface CanvasQuiz {
  id: number;
  title: string;
  html_url?: string | null;
  /** Instructions HTML shown before the quiz starts. */
  description?: string | null;
  quiz_type?: "practice_quiz" | "assignment" | "graded_survey" | "survey" | string | null;
  /** Minutes, or null for no limit. */
  time_limit?: number | null;
  /** -1 means unlimited. */
  allowed_attempts?: number | null;
  points_possible?: number | null;
  question_count?: number | null;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  published?: boolean | null;
  shuffle_answers?: boolean | null;
  show_correct_answers?: boolean | null;
  one_question_at_a_time?: boolean | null;
}

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
