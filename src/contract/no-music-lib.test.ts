/**
 * music_io is the platform layer: bytes, audio, files. It must not depend on
 * music_lib, which is the domain.
 *
 * This held once and was lost gradually — live playback took a `Score`, and an
 * engine holding a score then needed tempo maths, tie joining and the GM tables
 * to do anything with it. By the end music_io imported music_lib in eight
 * files, the two packages were mutually dependent, and neither could be
 * type-checked at release time until the other had published.
 *
 * A grep test is crude, but the alternative is noticing that again in a year.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

describe('music_io does not depend on music_lib', () => {
  const src = new URL('../', import.meta.url).pathname;

  it('imports it nowhere, including in tests', () => {
    // Import statements, not the bare string — this file names the package in
    // its own prose, and so may any comment explaining why the rule exists.
    const imports = /(?:from|require\()\s*['"]@sudobility\/music_lib/;
    const offenders = sourceFiles(src)
      .filter((f) => imports.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(src.length));
    expect(offenders).toEqual([]);
  });

  it('does not declare it as a dependency', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url).pathname, 'utf8'),
    ) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      expect(pkg[field]?.['@sudobility/music_lib']).toBeUndefined();
    }
  });
});
