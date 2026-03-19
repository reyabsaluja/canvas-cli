import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";

/**
 * Tool definitions for the investigation agent.
 * Most tools operate on the local ingestion cache.
 * download_module_file can make live Canvas API calls.
 */
export const INVESTIGATION_TOOLS: Tool[] = [
  {
    name: "search_modules",
    description:
      "Search all course module items by keyword. Returns matching module items with their module name, item type, title, and content ID. Use this to find relevant instruction documents, pages, or files within the course structure.",
    input_schema: {
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
    input_schema: {
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
      "Read and extract text from a downloaded course file by filename. Supports PDFs, text files, HTML, and markdown. The file must have been downloaded during ingestion. Use list_downloaded_files first to see available files. If the file you need isn't downloaded, use download_module_file instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: {
          type: "string",
          description: "The filename of the downloaded attachment to read",
        },
      },
      required: ["filename"],
    },
  },
  {
    name: "download_module_file",
    description:
      "Download a file from a course module and extract its text. Use this when you find a relevant file in a module (via search_modules or get_module_items) that hasn't been downloaded yet. Provide the exact module item title. This fetches the file from Canvas, saves it locally, and returns the extracted text.",
    input_schema: {
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
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_assignments",
    description:
      "List all course assignments with their due dates and points. Use this to cross-reference due dates and understand the assignment timeline.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_downloaded_files",
    description:
      "List all files that were downloaded during course ingestion. Shows filename, source type, and download status. Use this to see what documents are available to read with read_document.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "search_files",
    description:
      "Search the course file index by keyword. Returns matching files with their names, content types, and sizes. These files may or may not be downloaded locally.",
    input_schema: {
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
      "Signal that you have gathered enough evidence and are ready to produce the final assignment workup. Call this ONLY when you have actually read the relevant instruction documents (not just listed them). Include a detailed summary of your key findings.",
    input_schema: {
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
