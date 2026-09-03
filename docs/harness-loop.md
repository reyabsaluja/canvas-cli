# Harness improvement loop

State file for the recurring "find one concrete improvement" loop. Each
iteration reads this file first, works the **next** area in the rotation,
appends a Done entry, and rotates the pointer. Keep entries to one line.

## Rotation

Areas, in order: `discover` → `extract` → `retrieve` → `reason` → `ground` → back to `discover`.

Next area: **reason**

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

- discover: course tabs / external tool links not recorded
- extract: zip summary text still capped at 30k/file, 50k total; no OCR for scanned PDFs
- retrieve: artifact-level scoring is presence-only so long docs win ties (`CoursePassage.score` is available as a tie-break); `list_files` still shows both the `[file]` and `[attachment]` entries for downloaded Files-tab files
- ground: workups silently prefer Canvas over the syllabus on due-date conflicts instead of surfacing them; numeric-claim check only covers digit-bearing tokens (spelled-out numbers, weekday inferences like "Friday" are not checked); a date's bare day number is matched by any unrelated number in the evidence ("March 20" passes because "style 20 marks" exists), so date claims should be checked as month+day pairs; the base note can say "matched search evidence, not a full document read" even when a read was made this turn

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
- 2026-09-03 discover: files attached to announcements, discussion posts, and replies (topic attachments[] / entry attachment) downloaded and extracted, deduped against Files-tab crawl, "files attached to posts" count in summary
- 2026-09-03 extract: HTML tables keep colspan/rowspan/nested tables/captions and row-header keys, `<dl>` lists render as term: definition lines; announcement and discussion extracts list the files attached to the post and its replies (agent stalled twice on the long gate; caller ran the full gate: 836/836)
- 2026-09-03 retrieve: search_workspace previews are a 2,400-char window centred on the matching passage instead of the first 2,000 chars (two agents stalled because the Mac slept; caller finished it). Still open from this lap: gate answers from a truncated memory (backlog item kept)
- 2026-09-03 reason: read_file section lookup falls back to a raw "## Page N"/heading scan when the splitter folded the section away (image-only pages get an explicit "no extractable text" note); accepts "p. 12", "12", heading fragments (agent stalled twice from Mac sleep; caller finished it; truncated-memory gate item still open)
- 2026-09-03 ground: not-found answers name what was checked ("Not found after checking: Lab4.pdf (read in full); course search for \"penalty\" (no matches); rubric.pdf (could not read)") via verification.checkedSources + finalizeAnswerText trail; /ask prompt no longer caps answers at 2-4 sentences; prompt tells the agent to list checked sources in not-found answers
- 2026-09-03 discover: embedded recordings (iframe/video/audio/embed/Canvas media anchors on YouTube, Panopto, Kaltura, Echo360, Zoom, Loom, Google, Canvas Studio) in pages, syllabus, announcements, discussions and assignment descriptions become video lecture entries with title, host and lecture number (agent stalled from Mac sleep; caller finished it)
- 2026-09-03 extract: image-only PDF pages keep their "## Page N" heading with an explicit "no extractable text" note, so every page stays addressable and citable; fully image-only PDFs still report the unreadable marker (caller did it directly)
- 2026-09-03 retrieve: cut-off whole reads record their omitted section labels on the ArtifactRef; when a question names a page/heading the read never included ("page 57", "p. 12", "Part 4", "grading rubric") the gate issues a section read instead of answering from truncated memory (caller did it directly)
- 2026-09-03 reason: prompt and reflection footer teach a figure check (every date/time/%/value must come from a result read this turn, else read the section first); the footer names the sections a cut-off read omitted and the section: call to fetch them (caller did it directly)
- 2026-09-03 ground: the numeric-claim check also accepts figures supported by earlier turns' grounded reads (priorObservations), so a correctly remembered due date is no longer flagged as unconfirmed; citations and confidence still use this turn's evidence only (caller did it directly)
- 2026-09-03 discover: quizzes (classic + New Quizzes, incl. practice quizzes and surveys) fetched from /quizzes and stored as pages ("Quiz: <title>") with type, due/lock dates, time limit, attempts, points, question count and instructions; count in ingestion.json and summary; 403 degrades to none (caller did it directly)
- 2026-09-03 extract: links whose visible text is generic ("here", "download", "this link") now render the filename from title/aria-label/download attributes, and descriptive labels gain the filename in brackets, so a search for the handout finds the page that links it (caller did it directly)
- 2026-09-03 retrieve: workspace extracted files are now split on their markdown headings ("## Page N", DOCX/PPTX headings) like course documents instead of paragraph chunks, so page/heading sections are searchable and citable inside workspaces; plus course-vocabulary synonym expansion in both scorers (due/deadline, rubric/grading/marking, late/penalty, submit/upload, exam/midterm, lecture/slides, ...) at 0.6 weight so direct matches still win (caller did it directly)
