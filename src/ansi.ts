/**
 * Strips terminal control sequences from Kiro's output.
 *
 * kiro-cli colours its output and moves the cursor even under
 * `--no-interactive`: a real run emits SGR colours, `?25l`/`?25h` to hide and
 * show the cursor, and `1G` to return to the start of the line. That text is
 * read in Claude Code, not a terminal, so the sequences arrive as literal
 * `ESC[0m` noise in a review and are charged against the stored output budget.
 *
 * Stateful because a sequence can be split across two pipe reads, the same way
 * a multi-byte character can: an incomplete trailing sequence is held until the
 * next chunk rather than emitted as text.
 */

const ESC = "\x1b";
const BEL = "\x07";

/** Longest sequence held while waiting for its terminator. */
const MAX_PENDING = 64;

/** A CSI sequence ends at the first byte in this range. */
const CSI_FINAL = /[@-~]/;

/** ESC, one of these, then one more character: charset selection and the like. */
const INTERMEDIATE_INTRODUCERS = "()*+-./#%";

/**
 * ESC plus one of these is the whole sequence: keypad mode, save and restore
 * cursor, index and reverse index, full reset.
 */
const SINGLE_FINALS = "=>78MDEHc";

export class AnsiStripper {
  /** An escape sequence begun in an earlier chunk and not yet terminated. */
  private pending = "";

  write(chunk: string): string {
    const text = this.pending + chunk;
    this.pending = "";
    let out = "";
    let i = 0;

    while (i < text.length) {
      const c = text[i]!;
      if (c !== ESC) {
        // Newlines and tabs are content; the other C0 controls are cursor and
        // screen management, so they go with the sequences.
        if (c === "\n" || c === "\t" || (c >= " " && c !== "\x7f")) out += c;
        i += 1;
        continue;
      }

      const after = this.skipSequence(text, i);
      if (after === null) {
        // The sequence runs off the end of this chunk, so hold it for the next
        // one. Capped, so a stray ESC in a transcript cannot swallow the rest.
        const tail = text.slice(i);
        if (tail.length <= MAX_PENDING) {
          this.pending = tail;
          return out;
        }
        i += 1; // too long to be a sequence: drop the ESC and carry on
        continue;
      }
      i = after;
    }
    return out;
  }

  /** Anything still held at the end of the stream was never a sequence. */
  end(): string {
    const held = this.pending;
    this.pending = "";
    return held.split(ESC).join("");
  }

  /**
   * Index just past the sequence starting at `start`, or null when the sequence
   * is not yet complete in `text`.
   */
  private skipSequence(text: string, start: number): number | null {
    const next = text[start + 1];
    if (next === undefined) return null;

    // CSI: ESC [ parameters, then one final byte. Covers colours, ?25l/?25h
    // and cursor movement -- everything a real kiro-cli run actually emits.
    if (next === "[") {
      let i = start + 2;
      while (i < text.length && !CSI_FINAL.test(text[i]!)) i += 1;
      return i < text.length ? i + 1 : null;
    }

    // OSC: ESC ] ... terminated by BEL or by ESC \.
    if (next === "]") {
      let i = start + 2;
      while (i < text.length) {
        if (text[i] === BEL) return i + 1;
        if (text[i] === ESC) {
          if (text[i + 1] === undefined) return null;
          if (text[i + 1] === "\\") return i + 2;
        }
        i += 1;
      }
      return null;
    }

    if (INTERMEDIATE_INTRODUCERS.includes(next)) {
      return text[start + 2] === undefined ? null : start + 3;
    }

    if (SINGLE_FINALS.includes(next)) return start + 2;
    // Anything else after ESC is not a family kiro-cli emits. It is far likelier
    // to be a stray ESC in the transcript than a real single-character escape,
    // so drop the ESC alone and keep what follows rather than eating a character
    // of content.
    return start + 1;
  }
}

/** Convenience for a string that is already complete. */
export function stripAnsi(text: string): string {
  const stripper = new AnsiStripper();
  return stripper.write(text) + stripper.end();
}
