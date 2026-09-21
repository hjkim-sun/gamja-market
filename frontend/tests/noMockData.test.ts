import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const srcRoot = resolve(process.cwd(), 'src');
const mockRoot = join(srcRoot, 'lib', 'mock');
const deletedMocks = ['requests.ts', 'users.ts', 'applicants.ts'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return ['.ts', '.tsx', '.js', '.jsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

describe('애플리케이션 목업 데이터 제거', () => {
  it.each(deletedMocks)('src/lib/mock/%s 파일이 존재하지 않는다', (filename) => {
    expect(existsSync(join(mockRoot, filename))).toBe(false);
  });

  it('src 전체에 lib/mock import가 하나도 남아 있지 않다', () => {
    const imports = sourceFiles(srcRoot)
      .filter((path) => /(?:@\/lib\/mock|lib\/mock)(?:\/|['"])/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(srcRoot, path));

    expect(imports).toEqual([]);
  });
});
