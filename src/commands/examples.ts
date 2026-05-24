// Descriptions aligned to column 40
export function examplesCommand(): void {
  process.stdout.write(`canvas-cli — Common Workflows

Getting Started:
  $ canvas-cli login                   Interactive setup wizard
  $ canvas-cli status                  Verify everything is configured correctly

Working with Courses:
  $ canvas-cli ingest CS101            Cache course content locally
  $ canvas-cli ingest CS101 --refresh  Force re-download of course content
  $ canvas-cli ingest CS101 --json     Get structured output for scripting

Using the Interactive TUI:
  $ canvas-cli                         Launch the full interactive interface
                                       (Browse courses, read content, ask AI questions)

Managing Multiple Accounts:
  $ canvas-cli login --profile school  Set up school account
  $ canvas-cli login --profile work    Set up work account
  $ canvas-cli status --profile work   Check work account status
  $ export CANVAS_CLI_PROFILE=work     Switch active profile

Debugging:
  $ canvas-cli --debug ingest CS101    Show verbose debug output
  $ canvas-cli status                  Check if credentials are valid
`);
}
