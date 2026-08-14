import * as assert from 'assert';
import { footerMetaHtml, licenseName, repositoryUrl } from '../src/repoLink';

// --- repositoryUrl: the shapes npm allows ---

assert.strictEqual(
  repositoryUrl({ repository: { type: 'git', url: 'https://github.com/ShiZa039/ai-office-dashboard.git' } }),
  'https://github.com/ShiZa039/ai-office-dashboard',
  'our own package.json shape, .git dropped',
);
assert.strictEqual(
  repositoryUrl({ repository: 'https://github.com/a/b' }),
  'https://github.com/a/b',
  'repository as a bare string',
);
assert.strictEqual(
  repositoryUrl({ repository: { url: 'git+https://github.com/a/b.git' } }),
  'https://github.com/a/b',
  'the git+ prefix is stripped',
);
assert.strictEqual(
  repositoryUrl({ repository: { url: 'git@github.com:a/b.git' } }),
  'https://github.com/a/b',
  'scp-style remote becomes browsable',
);
assert.strictEqual(
  repositoryUrl({ repository: { url: 'ssh://git@gitlab.com/team/proj.git' } }),
  'https://gitlab.com/team/proj',
  'ssh remote becomes browsable',
);
assert.strictEqual(
  repositoryUrl({ repository: { url: 'git://github.com/a/b.git' } }),
  'https://github.com/a/b',
  'git:// becomes https',
);
assert.strictEqual(
  repositoryUrl({ repository: 'github:a/b' }),
  'https://github.com/a/b',
  'github: shorthand',
);
assert.strictEqual(repositoryUrl({ repository: 'a/b' }), 'https://github.com/a/b', 'bare shorthand');
assert.strictEqual(
  repositoryUrl({ repository: 'https://github.com/a/b/' }),
  'https://github.com/a/b',
  'a trailing slash does not survive',
);

// --- repositoryUrl: nothing usable ---

for (const pkg of [
  {},
  null,
  'not an object',
  { repository: '' },
  { repository: {} },
  { repository: { url: 42 } },
  { repository: 'https://github.com' }, // host only, no project
  { repository: 'javascript:alert(1)' },
  { repository: 'file:///etc/passwd' },
]) {
  assert.strictEqual(repositoryUrl(pkg), '', `no browsable https URL: ${JSON.stringify(pkg)}`);
}

// --- licenseName ---

assert.strictEqual(licenseName({ license: 'MIT' }), 'MIT', 'license read');
assert.strictEqual(licenseName({ license: '  MIT  ' }), 'MIT', 'license trimmed');
assert.strictEqual(licenseName({}), '', 'no license → empty');
assert.strictEqual(licenseName({ license: { type: 'MIT' } }), '', 'legacy object license → empty');

// --- footerMetaHtml ---

{
  const html = footerMetaHtml({
    repository: { type: 'git', url: 'https://github.com/ShiZa039/ai-office-dashboard.git' },
    license: 'MIT',
  });
  assert.strictEqual(
    html,
    ' · <a class="office-repo" href="https://github.com/ShiZa039/ai-office-dashboard"' +
      ' title="https://github.com/ShiZa039/ai-office-dashboard">GitHub</a> · MIT',
    'full footer tail',
  );
}
{
  const html = footerMetaHtml({ repository: 'https://gitlab.com/a/b', license: 'MIT' });
  assert.ok(html.includes('>GitLab</a>'), 'a known forge gets its own label');
}
{
  const html = footerMetaHtml({ repository: 'https://git.example.org/a/b', license: 'MIT' });
  assert.ok(html.includes('>git.example.org</a>'), 'an unknown forge shows its hostname');
}
{
  const html = footerMetaHtml({ repository: 'https://www.github.com/a/b' });
  assert.ok(html.includes('>GitHub</a>'), 'www. does not hide a known forge');
  assert.ok(!html.includes('MIT'), 'no license → no license part');
}

// A separator is only ever emitted with something after it.
assert.strictEqual(footerMetaHtml({}), '', 'neither repo nor license → nothing');
assert.strictEqual(footerMetaHtml({ license: 'MIT' }), ' · MIT', 'license alone still reads right');

// The href lands in markup, so quotes must not be able to escape the attribute.
{
  const html = footerMetaHtml({ repository: 'https://evil.example/a"><script>x</script>' });
  assert.ok(!html.includes('<script>'), 'markup in the URL is escaped');
  assert.ok(html.includes('&quot;'), 'a quote in the URL is escaped');
}

console.log('All repoLink tests passed.');
