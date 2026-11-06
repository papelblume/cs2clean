// How the Hero sidecar (leetify-hero-cli.ts) ends: one result line on stdout, then the process exits.
//
// The app reads the LAST JSON line the sidecar printed, so a second line would replace the first, and the second one
// is never the answer: it is an error that came after it (Hero Core rejecting a promise while it shuts down, say,
// reaching the process's "unhandledRejection" before the first line has been flushed and the process has exited).
// So only the first result is written, and whatever comes after it is handed to `ignored` instead.

/** Writes a line to stdout and calls `done` when it has been flushed (process.stdout.write(line, done)). */
export type WriteLine = (line: string, done: () => void) => void;

export function createFinisher(
  write: WriteLine,
  exit: (code: number) => void,
  ignored: (result: unknown, code: number) => void = () => {},
): (result: unknown, code: number) => void {
  let finished = false;
  return (result, code) => {
    if (finished) {
      ignored(result, code);
      return;
    }
    finished = true;
    write(JSON.stringify(result) + "\n", () => exit(code));
  };
}
