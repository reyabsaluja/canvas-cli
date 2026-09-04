import type { ToolDefinition } from "../ai/provider.js";

/**
 * Tool definitions for the investigation agent.
 * Most tools operate on the local ingestion cache.
 * download_module_file can make live Canvas API calls.
 */
export const INVESTIGATION_TOOLS: ToolDefinition[] = [
  {
    name: "search_modules",
    description:
      "Search all course module items by keyword. Returns matching module items with their module name, item type, title, and content ID. Use this to find relevant instruction documents, pages, or files within the course structure.",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search keyword or phrase to match against module item titles",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_module_items",
    description:
      "Get all items in a specific module by module name. Returns the full list of items in that module with their types, titles, and content IDs. Use this to explore the context around a relevant module.",
    parameters: {
      type: "object" as const,
      properties: {
        module_name: {
          type: "string",
          description: "The name of the module to retrieve items from (case-insensitive partial match)",
        },
      },
      required: ["module_name"],
    },
  },
  {
    name: "read_document",
    description:
      "Read and extract text from a downloaded course file by filename. Supports PDFs, text files, HTML, and markdown. The file must have been downloaded during ingestion. Use list_downloaded_files first to see available files. If the file you need isn't downloaded, use download_module_file instead. Without a section it returns the document from the start, up to about 60,000 characters; PDF pages appear as '## Page N' headings, and a longer document ends with a note naming the pages that were not included. Pass section (e.g. 'Page 12', '12', or a heading such as 'Part 3') to read just that section in full, which is how to reach pages past the cut-off.",
    parameters: {
      type: "object" as const,
      properties: {
        filename: {
          type: "string",
          description: "The filename of the downloaded attachment to read",
        },
        section: {
          type: "string",
          description:
            "Optional. A page reference ('Page 12', '12') or heading fragment ('Part 3: Interrupts') to read in full instead of the document head.",
        },
      },
      required: ["filename"],
    },
  },
  {
    name: "download_module_file",
    description:
      "Download a file from a course module and extract its text. Use this when you find a relevant file in a module (via search_modules or get_module_items) that hasn't been downloaded yet. Provide the exact module item title. This fetches the file from Canvas, saves it locally, and returns the extracted text.",
    parameters: {
      type: "object" as const,
      properties: {
        item_title: {
          type: "string",
          description: "The exact title of the module item (file) to download",
        },
      },
      required: ["item_title"],
    },
  },
  {
    name: "get_syllabus",
    description:
      "Get the full course syllabus text. Use this to find due dates, assignment schedules, grading policies, and course overview information.",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_assignments",
    description:
      "List all course assignments with their due dates and points. Use this to cross-reference due dates and understand the assignment timeline.",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_downloaded_files",
    description:
      "List all files that were downloaded during course ingestion. Shows filename, source type, and download status. Use this to see what documents are available to read with read_document.",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "search_files",
    description:
      "Search the course file index by keyword. Returns matching files with their names, content types, and sizes. These files may or may not be downloaded locally.",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search keyword or phrase to match against file names",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "complete_investigation",
    description:
      "Signal that you have gathered enough evidence and are ready to produce the final assignment workup. Call this ONLY when you have actually read the relevant instruction documents (not just listed them) and confirmed a due-date source from Canvas, list_assignments, or get_syllabus. The runtime will reject this call if those minimum evidence requirements are still missing. Include a detailed summary of your key findings.",
    parameters: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description: "Detailed summary of what you've learned about the assignment from reading the actual documents",
        },
      },
      required: ["summary"],
    },
  },
];
