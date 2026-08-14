/**
 * The "v0.20.0 · GitHub · MIT" footer line of the dashboard. The extension is
 * open source, so the version tag doubles as a way into the repository — but
 * the URL and the license belong to `package.json`, not to a string baked into
 * the markup, or they drift the moment the remote moves.
 *
 * No vscode imports — unit-testable.
 */

/** `repository` in the shapes npm allows, reduced to a browsable https URL. */
export function repositoryUrl(pkg: unknown): string {
  const repo = field(pkg, 'repository');
  const raw =
    typeof repo === 'string' ? repo : typeof field(repo, 'url') === 'string' ? String(field(repo, 'url')) : '';
  return normalizeRepoUrl(raw);
}

/** `license`, e.g. `MIT`; empty when unstated. */
export function licenseName(pkg: unknown): string {
  const license = field(pkg, 'license');
  return typeof license === 'string' ? license.trim() : '';
}

/**
 * Everything that follows the version in the footer, already escaped:
 * ` · <a …>GitHub</a> · MIT`. Empty when package.json names neither — a
 * dangling separator would be worse than no link at all.
 */
export function footerMetaHtml(pkg: unknown): string {
  const url = repositoryUrl(pkg);
  const license = licenseName(pkg);
  const parts: string[] = [];
  if (url) {
    const attr = escapeHtml(url);
    parts.push(`<a class="office-repo" href="${attr}" title="${attr}">${escapeHtml(hostLabel(url))}</a>`);
  }
  if (license) parts.push(escapeHtml(license));
  return parts.map((part) => ` · ${part}`).join('');
}

/**
 * Git remotes come in flavours npm accepts but a browser does not: the `git+`
 * prefix, the `.git` suffix, scp-style `git@host:user/repo`, and the
 * `github:user/repo` / bare `user/repo` shorthands. Anything that does not end
 * up as http(s) is dropped — the footer must never emit a `javascript:` href.
 */
function normalizeRepoUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';

  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url);
  if (shorthand) url = `https://github.com/${shorthand[1]}/${shorthand[2]}`;

  url = url.replace(/^git\+/, '');
  const scp = /^(?:ssh:\/\/)?git@([^/:]+):?\/?(.+)$/.exec(url);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  url = url.replace(/^git:\/\//, 'https://');
  url = url.replace(/\.git$/, '').replace(/\/+$/, '');

  return /^https?:\/\/[^/]+\/.+/i.test(url) ? url : '';
}

/** `https://github.com/a/b` → `GitHub`; an unknown forge shows its hostname. */
function hostLabel(url: string): string {
  const host = /^https?:\/\/([^/]+)/i.exec(url)?.[1].toLowerCase().replace(/^www\./, '') ?? '';
  const known: Record<string, string> = {
    'github.com': 'GitHub',
    'gitlab.com': 'GitLab',
    'bitbucket.org': 'Bitbucket',
    'codeberg.org': 'Codeberg',
  };
  return known[host] ?? host;
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
