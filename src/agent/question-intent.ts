export function questionExplicitlyComparesSources(question: string): boolean {
  const normalized = question.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    /\b(compare|comparison|versus|vs\.?|differ|difference|different|conflict|conflicts|contradict|contradiction|reconcile|consistent|inconsistent|disagree|disagreement)\b/i.test(
      normalized
    ) ||
    /\bcompare\b[\s\S]*\bto\b/i.test(normalized) ||
    /\bbetween\b[\s\S]*\band\b/i.test(normalized) ||
    /\bdo\b[\s\S]*\bagree\b/i.test(normalized) ||
    /\bwhich is correct\b/i.test(normalized) ||
    /\bsame or different\b/i.test(normalized)
  );
}

export function questionNeedsMultipleSources(question: string): boolean {
  const normalized = question.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    questionExplicitlyComparesSources(normalized) ||
    /\b(changed|change since|what changed)\b/i.test(normalized)
  );
}
