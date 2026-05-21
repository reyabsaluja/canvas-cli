import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLatexManualInstallMessage,
  LATEX_MANUAL_INSTALL_LINES,
} from "../src/pdf/latex-setup.js";

test("formatLatexManualInstallMessage lists platform install commands", () => {
  const message = formatLatexManualInstallMessage();
  assert.match(message, /LaTeX compiler/);
  for (const line of LATEX_MANUAL_INSTALL_LINES) {
    assert.ok(message.includes(line));
  }
});
