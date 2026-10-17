// Reads the player list CS2 prints when you run `status` in its console.
//
// CS2 started with -condebug writes everything the console prints to game/csgo/console.log. The `status` command
// prints the players on the server with their names (no Steam IDs):
//
//   10/16 08:08:47 [Client] ---------players--------
//   10/16 08:08:47 [Client]   id     time ping loss      state   rate name
//   10/16 08:08:47 [Client]    0    42:54   13    0     active 786432 'Player01'
//   10/16 08:08:47 [Client] 65535 [NoChan]    0    0 challenging      0 ''        <- a slot still connecting
//   10/16 08:08:47 [Client]   24      BOT    0    0     active      0 'DemoRecorder'
//   10/16 08:08:47 [Client] #end
//
// Only the file is read, and only what is appended after the app starts watching: nothing touches the CS2 process.
// The names are matched to Steam IDs in name-match.ts.

import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

// ------------------------------------------------------------------ parsing

/** "10/16 08:08:47 [Client] ": the timestamp and tag CS2 puts in front of each line (absent when timestamps are off). */
const PREFIX = /^(\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) \[[^\]]*\] ?/;
const HEADER = /^-+\s*players\s*-+$/i;
//                         id      time     ping    loss    state    rate    'name'
const PLAYER = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\w+)\s+(\d+)\s+'(.*)'\s*$/;

/** A player the status list shows: the slot (the `id` column) and the name. */
export interface LobbyPlayer {
  slot: number;
  name: string;
}

/** One player line, or null for anything else: other lines, bots, and slots still connecting. */
export function parseStatusLine(line: string): LobbyPlayer | null {
  const m = PLAYER.exec(line);
  if (!m) return null;
  const [, slot, time, , , , , name] = m;
  // Bots have "BOT" as their time (the demo recorder is one); a slot that is still connecting has "[NoChan]" and no
  // name. Neither has a Steam account to look up.
  if (time === "BOT" || time === "[NoChan]" || !name) return null;
  return { slot: Number(slot), name };
}

export interface StatusBlock {
  players: LobbyPlayer[];
  /** The log's own timestamp of the block ("10/16 08:08:47"), when the lines carry one. */
  loggedAt: string | null;
}

/** A block this long without its "#end" isn't one (CS2's servers hold at most a few dozen slots). */
const MAX_BLOCK_LINES = 400;

/** Feed it the log's lines in order; it hands back a block when one ends. */
export class StatusParser {
  private players: LobbyPlayer[] | null = null; // null: not inside a block
  private loggedAt: string | null = null;
  private lines = 0;

  feed(raw: string): StatusBlock | null {
    const prefix = PREFIX.exec(raw);
    const line = prefix ? raw.slice(prefix[0].length) : raw;
    const text = line.trim();
    if (HEADER.test(text)) {
      this.players = []; // a header inside an unfinished block starts over
      this.loggedAt = prefix?.[1] ?? null;
      this.lines = 0;
      return null;
    }
    if (this.players === null) return null;
    if (text === "#end") {
      const done: StatusBlock = { players: this.players, loggedAt: this.loggedAt };
      this.players = null;
      return done;
    }
    if (++this.lines > MAX_BLOCK_LINES) {
      this.players = null;
      return null;
    }
    const p = parseStatusLine(line);
    if (p) this.players.push(p);
    return null;
  }
}

// ------------------------------------------------------------------ following the file

export interface TailerOptions {
  /** How often the file is looked at (ms). */
  pollMs?: number;
  /** The most read in one go (bytes); a larger backlog is read over several rounds. */
  maxReadBytes?: number;
}

/** A partial line this long is dropped rather than kept growing. */
const MAX_PARTIAL = 1_000_000;

/**
 * Calls `onLine` for every complete line appended to a file, like `tail -f`: it starts at the end of a file that
 * already exists (what is there is old), reads a file that appears later from its start, and copes with the file being
 * truncated or replaced, which is what happens when CS2 restarts. Half-written lines wait for their newline.
 */
export class LogTailer {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private firstLook = true;
  private ident: string | null = null;
  private pos = 0;
  private partial = "";
  private decoder = new StringDecoder("utf8");

  constructor(private path: string, private onLine: (line: string) => void, private o: TailerOptions = {}) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.o.pollMs ?? 250);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private reset(): void {
    this.pos = 0;
    this.partial = "";
    this.decoder = new StringDecoder("utf8");
  }

  /** Looks at the file once; a call made while one is running waits for that one. `start()` does this on a timer. Never throws. */
  poll(): Promise<void> {
    return (this.current ??= this.look().finally(() => { this.current = null; }));
  }

  private async look(): Promise<void> {
    try {
      let st;
      try {
        st = await stat(this.path);
      } catch {
        // No file (yet): one that appears later is new, so it is read from its start.
        this.firstLook = false;
        this.ident = null;
        this.reset();
        return;
      }
      const ident = `${st.dev}:${st.ino}`;
      if (this.firstLook) {
        this.firstLook = false;
        this.ident = ident;
        this.pos = st.size; // what is already there is old
        return;
      }
      if (this.ident !== ident) {
        this.ident = ident; // replaced by a new file
        this.reset();
      } else if (st.size < this.pos) {
        this.reset(); // truncated in place
      }
      while (this.pos < st.size) {
        const want = Math.min(st.size - this.pos, this.o.maxReadBytes ?? 1_000_000);
        const fh = await open(this.path, "r");
        let bytesRead = 0;
        const buf = Buffer.alloc(want);
        try {
          bytesRead = (await fh.read(buf, 0, want, this.pos)).bytesRead;
        } finally {
          await fh.close();
        }
        if (bytesRead === 0) break;
        this.pos += bytesRead;
        this.feed(this.decoder.write(buf.subarray(0, bytesRead)));
      }
    } catch {
      /* the file vanished mid-read, or can't be read right now: the next poll looks again */
    }
  }

  private feed(text: string): void {
    const parts = (this.partial + text).split("\n");
    this.partial = parts.pop() ?? "";
    if (this.partial.length > MAX_PARTIAL) this.partial = "";
    for (const p of parts) this.onLine(p.replace(/\r$/, ""));
  }
}

export interface StatusWatcher {
  stop(): void;
  /** Looks at the file now instead of waiting for the timer. */
  poll(): Promise<void>;
}

/** Watches a console.log and calls `onBlock` each time a `status` player list is printed to it. */
export function watchStatusBlocks(
  path: string,
  onBlock: (block: StatusBlock & { at: number }) => void,
  o: TailerOptions & { now?: () => number } = {},
): StatusWatcher {
  const parser = new StatusParser();
  const tailer = new LogTailer(path, (line) => {
    const block = parser.feed(line);
    if (block) onBlock({ ...block, at: (o.now ?? Date.now)() });
  }, o);
  tailer.start();
  return { stop: () => tailer.stop(), poll: () => tailer.poll() };
}
