import { spawnSync } from 'node:child_process';

const RECORD_SEPARATOR = '\u001e';
const FIELD_SEPARATOR = '\u001f';

/**
 * @typedef {object} CommitRecord
 * @property {string} sha
 * @property {string} authorName
 * @property {string} authorEmail
 * @property {string} committerName
 * @property {string} committerEmail
 * @property {string} message
 */

/**
 * Runs a read-only git command and returns stdout.
 *
 * @param {readonly string[]} args
 * @returns {string}
 */
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${String(result.status)}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * Every path tracked in the index, repository-relative.
 *
 * @returns {string[]}
 */
export function listTrackedFiles() {
  return git(['ls-files', '-z'])
    .split('\0')
    .filter((path) => path.length > 0);
}

/**
 * @param {string} revision
 * @returns {boolean}
 */
export function revisionExists(revision) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

/**
 * Commit metadata for a revision range, or whatever `git log` arguments are given.
 *
 * @param {readonly string[]} revisionArgs
 * @returns {CommitRecord[]}
 */
export function readCommits(revisionArgs) {
  const format = ['%H', '%an', '%ae', '%cn', '%ce', '%B'].join(FIELD_SEPARATOR) + RECORD_SEPARATOR;
  const output = git(['log', `--format=${format}`, ...revisionArgs]);
  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = '', authorName = '', authorEmail = '', committerName = '', committerEmail = '', message = ''] =
        record.split(FIELD_SEPARATOR);
      return { sha, authorName, authorEmail, committerName, committerEmail, message };
    });
}
