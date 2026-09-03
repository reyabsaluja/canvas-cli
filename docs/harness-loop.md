# Harness improvement loop

State file for the recurring "find one concrete improvement" loop. Each
iteration reads this file first, works the **next** area in the rotation,
appends a Done entry, and rotates the pointer. Keep entries to one line.

## Rotation

Areas, in order: `discover` → `extract` → `retrieve` → `reason` → `ground` → back to `discover`.

Next area: **discover**

## File ownership (so iterations never collide with each other or with edits in flight)

| Area | Owns | Never touches |
|---|---|---|
| discover | `src/ingest/{fetch-course-content,lecture-discovery,external-link-capture,ingest-course,attachment-selection,attachment-download,concurrency}.ts`, `src/canvas/**` (GET only), `src/format/render-ingestion-summary.ts`, `tests/helpers/*`, `tests/ingest-*`, `tests/integration-ingest.test.ts` | extraction, retrieval, agent, grounding files |
| extract | `src/ingest/{normalize-content,storage,attachment-extraction,syllabus-heuristics}.ts`, `src/extract/**`, `src/format/html-to-text.ts`, `tests/extract-*`, `tests/html-to-text.test.ts` | fetch/orchestration, retrieval, agent, grounding |
| retrieve | `src/ask/{retrieve,load-workspace,resolve-workspace,types}.ts`, `src/enrich/**`, `src/knowledge/**`, `src/tui/{course-retrieval,workspace-knowledge}.ts`, `src/agent/retrieval-gate.ts`, `src/ai/context-bundle.ts`, `tests/retrieval-*`, `tests/artifact-index*`, `tests/*retrieval*` | ingestion, agent prompts, grounding |
| reason | `src/tui/chat-agent/{prompt,tool-defs,memory,shared,types}.ts`, `src/tui/chat-agent.ts`, `src/agent/{question-intent,run-state,observation,observation-relevance,workup-coverage}.ts`, `src/work/{orchestrator,tools,tool-handlers,types}.ts`, `src/ai/prompts.ts`, `tests/agent-*` | verification, tool-execution, retrieval internals, ingestion |
| ground | `src/tui/chat-agent/{verification,tool-execution}.ts`, `src/agent/verify.ts`, `src/ask/{answer,render}.ts`, `src/work/{synthesis,generate-markdown,errors}.ts`, `tests/grounding-*`, `tests/workspace-chat-grounding.test.ts` | prompt.ts (write the needed sentence in the log instead), retrieval, ingestion |

`src/ingest/types.ts` is shared: additive changes only, appended in a marked block.

## Backlog (known gaps, pick from here first if still open)

- discover: embedded `<iframe>` media (YouTube/Panopto/Kaltura/Studio) in pages and announcements is dropped; quizzes (`/quizzes`) not fetched; discussion/announcement topic `attachments[]` (files attached to the post, not linked in HTML) not downloaded; course tabs / external tool links not recorded
- extract: HTML nested tables and `colspan` headers flattened; `<dl>` lists lost; file-link `title` hints dropped when anchor text is generic; zip summary text still capped at 30k/file, 50k total; image-only PDF pages leave no page marker (no OCR / "page N is an image" hint)
- retrieve: `search_workspace` section previews are the first 2000 chars, not a window around the match (reuse `buildMatchExcerpt`); no synonym expansion (due/deadline, rubric/grading); artifact-level scoring is presence-only so long docs win ties (`CoursePassage.score` is available as a tie-break); `list_files` still shows both the `[file]` and `[attachment]` entries for downloaded Files-tab files
- retrieve: retrieval gate answers from memory when `readArtifactIds` contains the artifact even if that whole read was cut off before the asked-about page; record truncation on the ArtifactRef and let the gate re-read with `section` when the question names a page/heading outside the remembered window
- reason: `read_file` section lookup falls back to the whole document when a page heading was folded into a neighbour by `splitDocumentIntoSections` (image-only pages with no body text); consider a raw "## Page N" heading scan as a last resort
- ground: no "not found after checking X, Y, Z" answer path (`finalizeAnswerText` ignores the observation trail); `/ask` prompt still caps answers at 2-4 sentences; workups silently prefer Canvas over the syllabus on due-date conflicts instead of surfacing them; numeric-claim check only covers digit-bearing tokens (spelled-out numbers, weekday inferences like "Friday" are not checked) and only against the current turn's verification observations, so a figure remembered from an earlier turn's read is reported as unconfirmed

## Done

- 2026-09-02 discover: folder-aware crawl of the whole Files tab (`GET /folders`), lecture-like files anywhere indexed, 4-wide downloads
- 2026-09-02 extract: DOCX/PPTX/XLSX extraction with headings, lists, tables, links, alt text, speaker notes, sheets
- 2026-09-02 retrieve: query stop-word stripping + conservative stemming on every search path; sections split on up to 4 heading levels
- 2026-09-02 reason: plan → investigate → reflect → decide loop with visible step budget (30), per-result reflection footer, sharper tool descriptions, workup-covered questions still get tools
- 2026-09-02 ground: section-level, answer-attributed citations for full-document reads; read results framed with their section outline
- 2026-09-02 discover: threaded discussion replies captured in thread order (nested /view replies, participant names, /entries fallback, has_more_replies paged), reply counts in summary
- 2026-09-02 extract: PDFs extracted page by page with "## Page N" citable headings, cap 30k → 400k with page-boundary truncation note, pdf.js fed a Uint8Array view (fixes "bad XRef entry" on pdfkit-made PDFs)
- 2026-09-02 retrieve: search_course shows the best-matching section + query-centred passage ("Page 57: ...MESI protocol...") instead of the document's first 140 chars; Files-tab file entries deduped against their extracted attachment
- 2026-09-02 reason: read_file takes section ("Page 57"/heading, fuzzy) and offset, whole-read cap 30k → 120k with a cut-off note naming omitted sections, outline lists every page as "Page 1–60", section reads carry sectionLabel for citations and never dedupe against truncated whole reads; work read_document 15k → 60k with page-aware cut-off
- 2026-09-02 ground: answers are checked for numeric claims (dates, times, %, addresses) missing from the evidence → confidence lowered one level + "could not confirm ..." note in chat and /ask; search_course cites the matched passage/section; fresh download_course_file reads get the 120k window/outline/cut-off note
