import { tailPlainToWidth } from "./screen.js";

const ACTIVE_PIN_PATTERN = /\/pin(\s+(\S*))?$/i;

export function getActivePinPartial(inputBuffer: string): string | null {
  const match = ACTIVE_PIN_PATTERN.exec(inputBuffer);
  if (!match) return null;
  return match[2] ?? "";
}

export function getVisibleInputSegment(
  inputText: string,
  boxWidth: number
): { text: string; start: number } {
  const text = tailPlainToWidth(inputText, Math.max(0, boxWidth - 1));
  return { text, start: Math.max(0, inputText.length - text.length) };
}

export function getPinOverlayIndent(inputText: string, boxWidth: number): number {
  const match = ACTIVE_PIN_PATTERN.exec(inputText);
  if (!match || typeof match.index !== "number") {
    return 1;
  }

  const visible = getVisibleInputSegment(inputText, boxWidth);
  return 1 + Math.max(0, match.index - visible.start);
}
