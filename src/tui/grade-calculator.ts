import type { CanvasAssignmentGroup, CanvasAssignmentGroupAssignment } from "../canvas/types.js";

export interface GradeAssignment {
  name: string;
  pointsPossible: number;
  score: number | null;
  dueAt: Date | null;
  submitted: boolean;
  graded: boolean;
  missing: boolean;
  late: boolean;
  omitted: boolean;
}

export interface GradeGroup {
  name: string;
  weight: number;
  assignments: GradeAssignment[];
  earnedPoints: number;
  possiblePoints: number;
  percentage: number | null;
}

export interface CourseGradeData {
  groups: GradeGroup[];
  currentScore: number | null;
  currentGrade: string | null;
  isWeighted: boolean;
  gradedWeightFraction: number;
  remainingWeightFraction: number;
}

export interface NeedResult {
  targetLabel: string;
  targetPercent: number;
  currentScore: number;
  currentGrade: string | null;
  status: "already" | "possible" | "impossible";
  neededAverage: number | null;
  maxAchievable: number | null;
  nearestReachable?: { label: string; percent: number; neededAvg: number }[];
  floorScore?: number;
}

const DEFAULT_SCALE: [string, number][] = [
  ["A+", 97], ["A", 93], ["A-", 90],
  ["B+", 87], ["B", 83], ["B-", 80],
  ["C+", 77], ["C", 73], ["C-", 70],
  ["D+", 67], ["D", 63], ["D-", 60],
  ["F", 0],
];

export function letterToPercent(letter: string): number | null {
  const entry = DEFAULT_SCALE.find(([l]) => l.toLowerCase() === letter.toLowerCase());
  return entry ? entry[1] : null;
}

export function percentToLetter(percent: number): string {
  for (const [letter, threshold] of DEFAULT_SCALE) {
    if (percent >= threshold) return letter;
  }
  return "F";
}

export function parseGradeData(groups: CanvasAssignmentGroup[]): CourseGradeData {
  const totalWeight = groups.reduce((sum, g) => sum + g.group_weight, 0);
  const isWeighted = totalWeight > 0;

  const parsed: GradeGroup[] = groups.map((g) => {
    const assignments = (g.assignments ?? []).map((a) => normalizeAssignment(a));
    const graded = assignments.filter((a) => a.graded && !a.omitted);
    const earnedPoints = graded.reduce((sum, a) => sum + (a.score ?? 0), 0);
    const possiblePoints = graded.reduce((sum, a) => sum + a.pointsPossible, 0);
    const percentage = possiblePoints > 0 ? (earnedPoints / possiblePoints) * 100 : null;

    return {
      name: g.name,
      weight: g.group_weight,
      assignments,
      earnedPoints,
      possiblePoints,
      percentage,
    };
  });

  const { currentScore, gradedWeightFraction, remainingWeightFraction } = computeCurrentScore(parsed, isWeighted);
  const currentGrade = currentScore !== null ? percentToLetter(currentScore) : null;

  return {
    groups: parsed,
    currentScore,
    currentGrade,
    isWeighted,
    gradedWeightFraction,
    remainingWeightFraction,
  };
}

function normalizeAssignment(a: CanvasAssignmentGroupAssignment): GradeAssignment {
  const sub = a.submission;
  const graded = sub?.workflow_state === "graded" && sub.score !== null;
  const submitted = graded || sub?.workflow_state === "submitted" || sub?.submitted_at !== null;
  return {
    name: a.name,
    pointsPossible: a.points_possible ?? 0,
    score: graded ? sub!.score : null,
    dueAt: a.due_at ? new Date(a.due_at) : null,
    submitted,
    graded,
    missing: sub?.missing ?? false,
    late: sub?.late ?? false,
    omitted: a.omit_from_final_grade,
  };
}

function computeCurrentScore(groups: GradeGroup[], isWeighted: boolean): {
  currentScore: number | null;
  gradedWeightFraction: number;
  remainingWeightFraction: number;
} {
  if (!isWeighted) {
    const totalEarned = groups.reduce((s, g) => s + g.earnedPoints, 0);
    const totalPossible = groups.reduce((s, g) => s + g.possiblePoints, 0);
    if (totalPossible === 0) return { currentScore: null, gradedWeightFraction: 0, remainingWeightFraction: 1 };

    const allPoints = groups.reduce((s, g) => s + g.assignments.reduce((as, a) => as + (a.omitted ? 0 : a.pointsPossible), 0), 0);
    const gradedPoints = groups.reduce((s, g) => s + g.assignments.filter(a => a.graded && !a.omitted).reduce((as, a) => as + a.pointsPossible, 0), 0);
    return {
      currentScore: (totalEarned / totalPossible) * 100,
      gradedWeightFraction: allPoints > 0 ? gradedPoints / allPoints : 0,
      remainingWeightFraction: allPoints > 0 ? (allPoints - gradedPoints) / allPoints : 1,
    };
  }

  let weightedSum = 0;
  let gradedWeight = 0;
  let totalWeight = 0;

  for (const group of groups) {
    if (group.weight <= 0) continue;
    totalWeight += group.weight;

    const totalPoints = group.assignments
      .filter((a) => !a.omitted)
      .reduce((s, a) => s + a.pointsPossible, 0);
    const gradedPoints = group.assignments
      .filter((a) => a.graded && !a.omitted)
      .reduce((s, a) => s + a.pointsPossible, 0);

    if (gradedPoints > 0 && group.percentage !== null) {
      const fractionGraded = totalPoints > 0 ? gradedPoints / totalPoints : 1;
      const effectiveWeight = group.weight * fractionGraded;
      weightedSum += (group.percentage / 100) * effectiveWeight;
      gradedWeight += effectiveWeight;
    }
  }

  if (gradedWeight === 0) {
    return { currentScore: null, gradedWeightFraction: 0, remainingWeightFraction: 1 };
  }

  const currentScore = (weightedSum / gradedWeight) * 100;
  const gradedFrac = gradedWeight / totalWeight;
  return {
    currentScore,
    gradedWeightFraction: gradedFrac,
    remainingWeightFraction: 1 - gradedFrac,
  };
}

export function calculateNeeded(data: CourseGradeData, targetPercent: number): NeedResult {
  const targetLabel = percentToLetter(targetPercent);
  const currentScore = data.currentScore ?? 0;
  const currentGrade = data.currentGrade;

  if (currentScore >= targetPercent) {
    const floorScore = computeFloor(data);
    return {
      targetLabel,
      targetPercent,
      currentScore,
      currentGrade,
      status: "already",
      neededAverage: null,
      maxAchievable: null,
      floorScore,
    };
  }

  if (data.remainingWeightFraction <= 0) {
    return {
      targetLabel,
      targetPercent,
      currentScore,
      currentGrade,
      status: "impossible",
      neededAverage: null,
      maxAchievable: currentScore,
    };
  }

  const neededOnRemaining = (targetPercent - currentScore * data.gradedWeightFraction) / data.remainingWeightFraction;

  if (neededOnRemaining > 100) {
    const maxAchievable = currentScore * data.gradedWeightFraction + 100 * data.remainingWeightFraction;
    const nearestReachable = findReachableGrades(data, maxAchievable);
    return {
      targetLabel,
      targetPercent,
      currentScore,
      currentGrade,
      status: "impossible",
      neededAverage: neededOnRemaining,
      maxAchievable,
      nearestReachable,
    };
  }

  return {
    targetLabel,
    targetPercent,
    currentScore,
    currentGrade,
    status: "possible",
    neededAverage: neededOnRemaining,
    maxAchievable: null,
  };
}

function computeFloor(data: CourseGradeData): number {
  return data.currentScore !== null
    ? data.currentScore * data.gradedWeightFraction
    : 0;
}

function findReachableGrades(data: CourseGradeData, maxAchievable: number): { label: string; percent: number; neededAvg: number }[] {
  const results: { label: string; percent: number; neededAvg: number }[] = [];
  for (const [letter, threshold] of DEFAULT_SCALE) {
    if (threshold >= maxAchievable) continue;
    if (letter === "F") break;
    const needed = (threshold - (data.currentScore ?? 0) * data.gradedWeightFraction) / data.remainingWeightFraction;
    if (needed <= 100 && needed >= 0) {
      results.push({ label: `${letter} (${threshold}%)`, percent: threshold, neededAvg: needed });
    }
    if (results.length >= 3) break;
  }
  return results;
}
