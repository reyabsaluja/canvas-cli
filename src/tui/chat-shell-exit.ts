export const USER_ABORT_EXIT_CODE = 130;

export async function exitShellAborted(
  closeShell: () => Promise<string | null>,
  exitProcess: (code: number) => never,
  logError: (message: string) => void = console.error
): Promise<never> {
  const persistError = await closeShell();
  if (persistError) {
    logError(`Failed to save chat session: ${persistError}`);
  }
  return exitProcess(USER_ABORT_EXIT_CODE);
}
