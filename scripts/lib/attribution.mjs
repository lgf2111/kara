/**
 * Kara's history records what changed, not which tools typed it. These patterns
 * must not appear in commit metadata, code comments or docs.
 *
 * Patterns are word-bounded on purpose: a bare "ai" matches "fail", "main",
 * "available" and "Cantonese"-adjacent words, and a bare "generated" matches
 * the ffmpeg-generated test fixtures this project relies on.
 *
 * @typedef {object} AttributionPattern
 * @property {string} id
 * @property {RegExp} pattern
 */

/** @type {readonly AttributionPattern[]} */
export const ATTRIBUTION_PATTERNS = [
  { id: 'co-authored-by', pattern: /co-?authored-by/i },
  { id: 'vendor-name', pattern: /\b(?:anthropic|openai|deepmind)\b/i },
  { id: 'assistant-name', pattern: /\b(?:claude|kiro|chatgpt|copilot|gemini|codex|cursor-?ai)\b/i },
  { id: 'model-version', pattern: /\bgpt-?\d/i },
  { id: 'generated-by-tool', pattern: /generated\s+(?:by|with|using)\s+(?:an?\s+)?(?:ai|llm|assistant|agent|model|bot)\b/i },
  { id: 'machine-authored', pattern: /\bai[-\s](?:generated|written|authored|assisted)\b/i },
  { id: 'machine-actor', pattern: /\bai\s+(?:assistant|agent|model|tool|pair)\b/i },
  { id: 'llm', pattern: /\bllm\b/i },
  { id: 'robot-emoji', pattern: /\u{1F916}/u },
];

/**
 * Paths skipped by the file-content scan. Short by design, each with a reason:
 *
 * - `CLAUDE.md`: pre-existing coding guidelines owned by the repo owner. Its
 *   name alone matches, and it makes no claim about who wrote the code.
 * - this module and its test: they hold the pattern list itself.
 * - `pnpm-lock.yaml`: dependency names are not authorship claims.
 *
 * @type {readonly string[]}
 */
export const CONTENT_SCAN_EXCLUSIONS = [
  'CLAUDE.md',
  'pnpm-lock.yaml',
  'scripts/lib/attribution.mjs',
  'scripts/lib/attribution.test.mjs',
];

/**
 * @param {string} filePath repository-relative path
 * @returns {boolean}
 */
export function isExcludedFromContentScan(filePath) {
  return CONTENT_SCAN_EXCLUSIONS.includes(filePath);
}

/**
 * @typedef {object} Finding
 * @property {string} id which pattern matched
 * @property {number} line 1-based line of the first matching line, 0 if the
 *   match spans a line break
 * @property {string} excerpt
 */

/**
 * @param {string} text
 * @returns {Finding[]}
 */
export function findAttribution(text) {
  /** @type {Finding[]} */
  const findings = [];
  const lines = text.split('\n');
  for (const { id, pattern } of ATTRIBUTION_PATTERNS) {
    if (!pattern.test(text)) {
      continue;
    }
    const index = lines.findIndex((line) => pattern.test(line));
    findings.push({
      id,
      line: index + 1,
      excerpt: index === -1 ? '' : (lines[index] ?? '').trim().slice(0, 120),
    });
  }
  return findings;
}
