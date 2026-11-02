export interface HeaderBlock {
  readonly pattern: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Parses Cloudflare Pages `_headers` syntax: an unindented line opens a path
 * block, indented `Name: value` lines belong to it, `#` lines are comments.
 */
export function parseHeadersFile(contents: string): HeaderBlock[] {
  const blocks: { pattern: string; headers: Record<string, string> }[] = [];

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue;
    }

    if (!/^\s/u.test(line)) {
      blocks.push({ pattern: line.trim(), headers: {} });
      continue;
    }

    const block = blocks.at(-1);
    if (block === undefined) {
      throw new Error(`header before any path pattern: ${line.trim()}`);
    }
    const colon = line.indexOf(':');
    if (colon === -1) {
      throw new Error(`malformed header line: ${line.trim()}`);
    }
    block.headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }

  return blocks;
}

export function headersForPattern(
  blocks: readonly HeaderBlock[],
  pattern: string,
): Readonly<Record<string, string>> {
  const block = blocks.find((candidate) => candidate.pattern === pattern);
  if (block === undefined) {
    throw new Error(`no header block for ${pattern}`);
  }
  return block.headers;
}
