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
  /** Present on records from GET /courses/:id/students/submissions. */
  assignment_id?: number;
  user_id?: number;
  /** Grader and peer comments visible to the student (include[]=submission_comments). */
  submission_comments?: CanvasSubmissionComment[] | null;
  /** The grader's rubric scoring for this submission (include[]=rubric_assessment). */
  rubric_assessment?: CanvasRubricAssessment | null;
}

/** One comment on a submission: text (plain and HTML), optional media and attached files. */
export interface CanvasSubmissionComment {
  id: number;
  author_id?: number | null;
  author_name?: string | null;
  comment?: string | null;
  /** Rich-text version, present with include[]=submission_html_comments. */
  html_comment?: string | null;
  created_at?: string | null;
  edited_at?: string | null;
  media_comment?: CanvasMediaComment | null;
  /** Files the grader attached to the comment (marked-up PDFs, rubrics). */
  attachments?: CanvasTopicAttachment[] | null;
}

export interface CanvasMediaComment {
  "content-type"?: string | null;
  display_name?: string | null;
  media_id?: string | null;
  media_type?: string | null;
  url?: string | null;
}

/** Rubric assessment keyed by rubric criterion id. */
export type CanvasRubricAssessment = Record<
  string,
  CanvasRubricAssessmentCriterion | null | undefined
>;

export interface CanvasRubricAssessmentCriterion {
  points?: number | null;
  rating_id?: string | number | null;
  comments?: string | null;
  comments_enabled?: boolean | null;
}

/**
 * One row of an assignment's `all_dates` (include[]=all_dates): the base
 * dates (`base: true`, titled "Everyone" / "Everyone else") or one override
 * for a section, group, or set of students.
 */
export interface CanvasAssignmentDate {
  id?: number | null;
  base?: boolean | null;
  title?: string | null;
  due_at: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  /** "CourseSection" | "Group" | "ADHOC" | "Noop" */
  set_type?: string | null;
  set_id?: number | null;
}

export interface CanvasAssignment {
  id: number;
  name: string;
  /** Group the assignment belongs to (for weighted grading schemes). */
  assignment_group_id?: number | null;
  due_at: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  html_url: string;
  course_id: number;
  has_submitted_submissions: boolean;
  submission?: CanvasSubmission;
  /** Base dates plus every section/group/student override (include[]=all_dates). */
  all_dates?: CanvasAssignmentDate[] | null;
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
  /** -1 means unlimited. */
  allowed_attempts?: number | null;
  peer_reviews?: boolean | null;
  automatic_peer_reviews?: boolean | null;
  peer_review_count?: number | null;
  /** Non-null when this is a group assignment. */
  group_category_id?: number | null;
  grade_group_students_individually?: boolean | null;
  anonymous_submissions?: boolean | null;
  omit_from_final_grade?: boolean | null;
  published?: boolean | null;
  /** Reason the assignment is locked for this student, when it is. */
  lock_explanation?: string | null;
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
  /** True when the final grade is a weighted sum of assignment groups. */
  apply_assignment_group_weights?: boolean | null;
}


export interface CanvasModule {
  id: number;
  name: string;
  position: number;
  items_count: number;
  items_url: string;
  unlock_at?: string | null;
  require_sequential_progress?: boolean | null;
  /** Modules that must be completed before this one unlocks. */
  prerequisite_module_ids?: number[] | null;
  state?: string | null;
}

export interface CanvasModuleItemCompletionRequirement {
  /** must_view | must_submit | must_contribute | min_score | must_mark_done */
  type: string;
  min_score?: number | null;
  completed?: boolean | null;
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
  completion_requirement?: CanvasModuleItemCompletionRequirement | null;
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
  position?: number | null;
  /** Drop rules applied within the group (e.g. drop the lowest lab). */
  rules?: {
    drop_lowest?: number | null;
    drop_highest?: number | null;
    never_drop?: number[] | null;
  } | null;
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

/** A course calendar event from GET /calendar_events?context_codes[]=course_<id>. */
export interface CanvasCalendarEvent {
  id: number;
  title: string;
  /** HTML body of the event. */
  description?: string | null;
  start_at?: string | null;
  end_at?: string | null;
  all_day?: boolean | null;
  all_day_date?: string | null;
  location_name?: string | null;
  location_address?: string | null;
  context_code?: string | null;
  context_name?: string | null;
  html_url?: string | null;
  workflow_state?: string | null;
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
