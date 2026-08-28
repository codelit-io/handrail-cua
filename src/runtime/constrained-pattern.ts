const MAX_PATTERN_LENGTH = 256;
export const MAX_PATTERN_INPUT_LENGTH = 10_000;

export class ConstrainedPatternError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ConstrainedPatternError";
  }
}

function parseFixedCount(source: string, cursor: number): { count: number; cursor: number } {
  if (source[cursor] !== "{") return { count: 1, cursor };
  const close = source.indexOf("}", cursor + 1);
  if (close < 0) throw new ConstrainedPatternError("Pattern has an unterminated fixed count.");
  const raw = source.slice(cursor + 1, close);
  if (!/^[1-9][0-9]{0,4}$/u.test(raw)) {
    throw new ConstrainedPatternError("Only positive fixed counts such as {5} are supported.");
  }
  const count = Number(raw);
  if (count > MAX_PATTERN_INPUT_LENGTH) {
    throw new ConstrainedPatternError("Pattern fixed count exceeds the bounded input limit.");
  }
  return { count, cursor: close + 1 };
}

function characterClassEnd(source: string, cursor: number): number {
  const close = source.indexOf("]", cursor + 1);
  if (close < 0) throw new ConstrainedPatternError("Pattern has an unterminated character class.");
  const body = source.slice(cursor + 1, close);
  if (!/^(?:[A-Za-z0-9](?:-[A-Za-z0-9])?)+$/u.test(body)) {
    throw new ConstrainedPatternError(
      "Character classes may contain only explicit ASCII letters, digits, and ranges.",
    );
  }
  return close + 1;
}

/**
 * Compile the deliberately tiny artifact pattern language.
 *
 * Accepted patterns are fully anchored concatenations of literal ASCII characters or
 * ASCII character classes, each optionally followed by one fixed repetition count.
 * There are no groups, alternation, backreferences, lookarounds, wildcards, or
 * variable quantifiers, so matching work is linear in the bounded input length.
 */
export function compileConstrainedPattern(source: string, maximumInputLength: number): RegExp {
  if (
    !Number.isSafeInteger(maximumInputLength) ||
    maximumInputLength < 1 ||
    maximumInputLength > MAX_PATTERN_INPUT_LENGTH
  ) {
    throw new ConstrainedPatternError(
      `Pattern matching requires maxLength between 1 and ${MAX_PATTERN_INPUT_LENGTH}.`,
    );
  }
  if (source.length < 3 || source.length > MAX_PATTERN_LENGTH) {
    throw new ConstrainedPatternError(
      `Pattern length must be between 3 and ${MAX_PATTERN_LENGTH} characters.`,
    );
  }
  if (!source.startsWith("^") || !source.endsWith("$")) {
    throw new ConstrainedPatternError("Pattern must be fully anchored with ^ and $.");
  }

  let cursor = 1;
  let maximumMatchedLength = 0;
  const bodyEnd = source.length - 1;
  while (cursor < bodyEnd) {
    const character = source[cursor];
    if (character === "[") {
      cursor = characterClassEnd(source, cursor);
    } else if (character === "\\") {
      const escaped = source[cursor + 1];
      if (escaped === undefined || !"-._:/@[]{}()^$\\".includes(escaped)) {
        throw new ConstrainedPatternError("Pattern contains an unsupported escape.");
      }
      cursor += 2;
    } else if (character !== undefined && /^[A-Za-z0-9 _.,:/@-]$/u.test(character)) {
      cursor += 1;
    } else {
      throw new ConstrainedPatternError(
        "Pattern contains an unsupported operator; use literals, ASCII classes, and fixed counts only.",
      );
    }

    const repeated = parseFixedCount(source, cursor);
    maximumMatchedLength += repeated.count;
    cursor = repeated.cursor;
    if (maximumMatchedLength > maximumInputLength) {
      throw new ConstrainedPatternError(
        "Pattern can match more characters than maxLength permits.",
      );
    }
  }
  if (cursor !== bodyEnd || maximumMatchedLength === 0) {
    throw new ConstrainedPatternError("Pattern body is empty or malformed.");
  }
  return new RegExp(source, "u");
}

export function constrainedPatternPasses(
  source: string,
  value: string,
  maximumInputLength: number,
): boolean {
  if (value.length > maximumInputLength) return false;
  return compileConstrainedPattern(source, maximumInputLength).test(value);
}
