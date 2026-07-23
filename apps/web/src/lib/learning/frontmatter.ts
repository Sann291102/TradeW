/**
 * A deliberately small YAML-subset parser for `docs/learning/` frontmatter.
 *
 * Why not a YAML library: the only one in the tree (`js-yaml`) is a transitive
 * dependency of tooling, not a declared one, so building on it would break
 * silently the day that tooling drops it. The frontmatter shape here is narrow,
 * authored in this repo, and documented in `docs/learning/README.md`.
 *
 * The rule this file follows is **reject, never guess**. A line it does not
 * understand throws rather than being skipped, because a silently dropped leg
 * would render a wrong payoff diagram — which is worse than a build failure.
 */

export class FrontmatterError extends Error {
  constructor(file: string, line: number, message: string) {
    super(`${file}:${line} — ${message}`);
    this.name = 'FrontmatterError';
  }
}

export type ParsedValue = string | ParsedValue[] | { [k: string]: ParsedValue };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Splits a document into its frontmatter block and body. */
export function splitFrontmatter(source: string): { frontmatter: string; body: string } | null {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return null;
  return { frontmatter: match[1], body: source.slice(match[0].length) };
}

interface Line {
  indent: number;
  text: string;
  /** 1-based line number within the frontmatter block, for error messages. */
  no: number;
}

function scan(block: string): Line[] {
  return block
    .split(/\r?\n/)
    .map((raw, i) => ({ raw, no: i + 1 }))
    .filter(({ raw }) => raw.trim() !== '' && !raw.trimStart().startsWith('#'))
    .map(({ raw, no }) => ({ indent: raw.length - raw.trimStart().length, text: raw.trim(), no }));
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parses one indentation level into a map. `lines[i]` is consumed in place via
 * the cursor object so nested calls advance the shared position.
 */
function parseMap(lines: Line[], cursor: { i: number }, indent: number, file: string): Record<string, ParsedValue> {
  const out: Record<string, ParsedValue> = {};

  while (cursor.i < lines.length) {
    const line = lines[cursor.i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new FrontmatterError(file, line.no, `unexpected indent (expected ${indent}, got ${line.indent})`);
    if (line.text.startsWith('- ')) break;

    const colon = line.text.indexOf(':');
    if (colon === -1) throw new FrontmatterError(file, line.no, `expected "key: value", got ${JSON.stringify(line.text)}`);

    const key = line.text.slice(0, colon).trim();
    const rest = line.text.slice(colon + 1).trim();
    if (!key) throw new FrontmatterError(file, line.no, 'empty key');
    if (key in out) throw new FrontmatterError(file, line.no, `duplicate key "${key}"`);
    cursor.i += 1;

    // Folded scalar — `key: >` followed by a more-indented block, joined with
    // spaces. `|` is intentionally unsupported: nothing here needs hard
    // newlines, and accepting it would imply a fidelity this parser lacks.
    if (rest === '>' || rest === '>-') {
      const parts: string[] = [];
      while (cursor.i < lines.length && lines[cursor.i].indent > indent) {
        parts.push(lines[cursor.i].text);
        cursor.i += 1;
      }
      if (!parts.length) throw new FrontmatterError(file, line.no, `folded scalar "${key}" has no content`);
      out[key] = parts.join(' ');
      continue;
    }

    if (rest === '|' || rest === '|-') throw new FrontmatterError(file, line.no, `literal block scalars ("|") are not supported; use ">" for "${key}"`);

    // Inline flow sequence, e.g. `aliases: [a, b]`.
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      out[key] = inner ? inner.split(',').map(unquote) : [];
      continue;
    }

    // Nested block — either a list of maps or a nested map.
    if (rest === '') {
      const next = lines[cursor.i];
      if (!next || next.indent <= indent) throw new FrontmatterError(file, line.no, `"${key}" has no value and no nested block`);

      if (next.text.startsWith('- ')) {
        out[key] = parseList(lines, cursor, next.indent, file);
      } else {
        out[key] = parseMap(lines, cursor, next.indent, file);
      }
      continue;
    }

    out[key] = unquote(rest);
  }

  return out;
}

/** Parses a block sequence whose items are maps (`- key: value` + siblings). */
function parseList(lines: Line[], cursor: { i: number }, indent: number, file: string): ParsedValue[] {
  const out: ParsedValue[] = [];

  while (cursor.i < lines.length) {
    const line = lines[cursor.i];
    if (line.indent < indent) break;
    if (!line.text.startsWith('- ')) {
      if (line.indent === indent) break;
      throw new FrontmatterError(file, line.no, `expected a list item at indent ${indent}`);
    }

    const firstPair = line.text.slice(2).trim();
    if (!firstPair.includes(':')) throw new FrontmatterError(file, line.no, 'list items must be maps ("- key: value")');

    // Re-present the item's first pair and its siblings as one map block. The
    // "- " prefix is two characters, so siblings sit at indent + 2.
    const itemLines: Line[] = [{ indent: indent + 2, text: firstPair, no: line.no }];
    cursor.i += 1;
    while (cursor.i < lines.length && lines[cursor.i].indent >= indent + 2 && !lines[cursor.i].text.startsWith('- ')) {
      itemLines.push(lines[cursor.i]);
      cursor.i += 1;
    }

    out.push(parseMap(itemLines, { i: 0 }, indent + 2, file));
  }

  return out;
}

/**
 * Parses a frontmatter block into a plain object.
 *
 * @param block the text between the `---` fences
 * @param file  path used in error messages
 */
export function parseFrontmatter(block: string, file: string): Record<string, ParsedValue> {
  const lines = scan(block);
  const cursor = { i: 0 };
  const result = parseMap(lines, cursor, 0, file);
  if (cursor.i < lines.length) throw new FrontmatterError(file, lines[cursor.i].no, `unconsumed content: ${JSON.stringify(lines[cursor.i].text)}`);
  return result;
}
