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

export interface CanvasCourseTab {
  id: string;
  label: string;
  type?: string | null;
  hidden?: boolean | null;
  visibility?: string | null;
  position?: number | null;
  html_url?: string | null;
  full_url?: string | null;
  url?: string | null;
  external_url?: string | null;
}

export interface CanvasSubmission {
  assignment_id?: number;
  user_id?: number;
  workflow_state: string;
  submitted_at: string | null;
  score: number | null;
  grade: string | null;
  attempt: number | null;
  late: boolean;
  missing: boolean;
  submission_comments?: CanvasSubmissionComment[] | null;
  rubric_assessment?: CanvasRubricAssessment | null;
}

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

export interface CanvasSubmissionComment {
  id: number;
  author_id?: number | null;
  author_name?: string | null;
  comment?: string | null;
  html_comment?: string | null;
  created_at?: string | null;
  edited_at?: string | null;
  media_comment?: CanvasMediaComment | null;
  attachments?: CanvasAttachment[] | null;
}

export interface CanvasMediaComment {
  "content-type"?: string | null;
  display_name?: string | null;
  media_id?: string | null;
  media_type?: string | null;
  url?: string | null;
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
  peer_reviews?: boolean | null;
  automatic_peer_reviews?: boolean | null;
  anonymous_peer_reviews?: boolean | null;
  intra_group_peer_reviews?: boolean | null;
  peer_review_count?: number | null;
  peer_reviews_assign_at?: string | null;
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
  attachments?: CanvasAttachment[] | null;
}

export interface CanvasAssignmentDateDetails {
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  only_visible_to_overrides?: boolean | null;
  overrides?: CanvasAssignmentDateOverride[] | null;
  assignment_overrides?: CanvasAssignmentDateOverride[] | null;
  peer_review_sub_assignment?: CanvasPeerReviewSubAssignmentDateDetails | null;
}

export interface CanvasPeerReviewSubAssignmentDateDetails {
  id?: number | null;
  title?: string | null;
  name?: string | null;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  only_visible_to_overrides?: boolean | null;
  overrides?: CanvasAssignmentDateOverride[] | null;
  assignment_overrides?: CanvasAssignmentDateOverride[] | null;
}

export interface CanvasAssignmentDateOverride {
  id?: number | null;
  title?: string | null;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  all_day?: boolean | null;
  all_day_date?: string | null;
  set_type?: string | null;
  student_ids?: number[] | null;
  group_id?: number | null;
  course_section_id?: number | null;
}

export interface CanvasAttachment {
  id: number;
  display_name?: string | null;
  filename?: string | null;
  url?: string | null;
  content_type?: string | null;
  size?: number | null;
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
  unlock_at?: string | null;
  require_sequential_progress?: boolean | null;
  prerequisite_module_ids?: number[] | null;
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
  indent?: number | null;
  completion_requirement?: CanvasModuleItemCompletionRequirement | null;
}

export interface CanvasModuleItemCompletionRequirement {
  type: string;
  min_score?: number | null;
  completed?: boolean | null;
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

export interface CanvasQuiz {
  id: number;
  title: string;
  html_url?: string | null;
  description?: string | null;
  quiz_type?: string | null;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  points_possible?: number | null;
  question_count?: number | null;
  time_limit?: number | null;
  allowed_attempts?: number | null;
  published?: boolean | null;
  assignment_id?: number | null;
}

export interface CanvasQuizQuestion {
  id: number;
  quiz_id: number;
  question_name: string;
  question_type: string;
  question_text: string;
  points_possible: number;
  position: number;
}

export interface CanvasCalendarEvent {
  id: number;
  title: string;
  description?: string | null;
  start_at?: string | null;
  end_at?: string | null;
  all_day?: boolean | null;
  location_name?: string | null;
  location_address?: string | null;
  context_code?: string | null;
  html_url?: string | null;
  workflow_state?: string | null;
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
  attachments?: CanvasAttachment[] | null;
  attachment?: CanvasAttachment | null;
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
  attachment?: CanvasAttachment | null;
  attachments?: CanvasAttachment[] | null;
}

/** Full topic view returned by GET /discussion_topics/:id/view. */
export interface CanvasDiscussionTopicView {
  participants: Array<{ id: number; display_name: string }>;
  unread_entries: number[];
  view: CanvasDiscussionEntry[];
  new_entries: CanvasDiscussionEntry[];
}
