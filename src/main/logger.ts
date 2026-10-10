// Centralized debug logger.
//
// Usage:
//   DEBUG=1 npm run start          # all categories
//   DEBUG=hero npm run start       # Hero scraper only
//   DEBUG=leetify npm run start    # Leetify API only
//   DEBUG=hero,leetify npm run start  # both

export function debug(category: string, ...args: unknown[]): void {
  const env = process.env.DEBUG ?? "";
  if (!env) return;
  if (env !== "1" && !env.split(",").map((c) => c.trim()).includes(category)) return;

  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}][${category}]`, ...args);
}

/**
 * A problem worth seeing without DEBUG set. Goes to stderr, so a process whose stdout carries a result (the
 * Hero sidecar's CLI) isn't disturbed.
 */
export function warn(category: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.warn(`[${ts}][${category}]`, ...args);
}
