export type RadarItemKind = "announcement" | "discussion";

export interface RadarItem {
  kind: RadarItemKind;
  topicId: number;
  courseId: number;
  courseName: string;
  title: string;
  authorName: string | null;
  postedAt: Date | null;
  lastReplyAt: Date | null;
  unreadCount: number;
  htmlUrl: string;
  locked: boolean;
}

export interface RadarThreadEntry {
  entryId: number;
  authorName: string;
  message: string;
  createdAt: Date;
  depth: number;
}

export interface RadarThread {
  topic: RadarItem;
  body: string;
  entries: RadarThreadEntry[];
  participantCount: number;
  totalEntries: number;
}

export type RadarFilter = "all" | "announcements" | "discussions";
