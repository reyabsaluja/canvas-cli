// Untyped CommonJS dependencies. Imported by path (not via createRequire) so
// the standalone-binary bundler can see and embed them.

declare module "pdf-parse/lib/pdf-parse.js" {
  // The lib entry, not the package root: pdf-parse's index.js runs a debug
  // self-test (reading a fixture PDF that isn't shipped) when it has no parent module.
  const pdfParse: any;
  export = pdfParse;
}

declare module "yauzl-promise" {
  const yauzl: any;
  export = yauzl;
}
