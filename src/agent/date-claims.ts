/**
 * Month + day claims in normalised text ("March 20", "20 March", "3/20").
 * Shared by the figure check in verify.ts and the contextual checks in
 * claim-context.ts so neither has to import the other.
 */

const MONTH_INDEX: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAMES =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
// "March 20", "Mar. 20, 2026", "20 March", "20th of March" (ordinals are
// stripped by normalizeClaimText), and numeric "3/20" or "03/20/2026".
const DATE_CLAIM_PATTERN = new RegExp(
  `\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b|\\b(\\d{1,2})(?:\\s+of)?\\s+(${MONTH_NAMES})\\.?(?:,?\\s+(\\d{4}))?\\b|\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b`,
  "gi"
);

export interface DateClaim {
  /** "3-20": month-day, independent of how it was written. */
  key: string;
  /** How the answer wrote it, for the note. */
  label: string;
  /** Numeric tokens that belong to this date (day, year, month number). */
  tokens: string[];
}

/** Month + day pairs mentioned in text. Exported for tests. */
export function extractDateClaims(normalizedText: string): DateClaim[] {
  const claims: DateClaim[] = [];
  for (const match of normalizedText.matchAll(DATE_CLAIM_PATTERN)) {
    const [, month1, day1, year1, day2, month2, year2, numMonth, numDay, numYear] = match;
    let month: number | null = null;
    let day: number | null = null;
    const tokens: string[] = [];
    if (month1 && day1) {
      month = MONTH_INDEX[month1.toLowerCase()] ?? null;
      day = Number.parseInt(day1, 10);
      tokens.push(day1.toLowerCase());
      if (year1) tokens.push(year1);
    } else if (day2 && month2) {
      month = MONTH_INDEX[month2.toLowerCase()] ?? null;
      day = Number.parseInt(day2, 10);
      tokens.push(day2.toLowerCase());
      if (year2) tokens.push(year2);
    } else if (numMonth && numDay) {
      month = Number.parseInt(numMonth, 10);
      day = Number.parseInt(numDay, 10);
      tokens.push(numMonth, numDay);
      if (numYear) tokens.push(numYear);
    }
    if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) continue;
    claims.push({ key: `${month}-${day}`, label: match[0].trim(), tokens });
  }
  return claims;
}
