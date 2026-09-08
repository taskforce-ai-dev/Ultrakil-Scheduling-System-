import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_MAPPING, MatrixMapping } from './mapping';

export function loadMatrixMapping(path: string): MatrixMapping {
  if (!existsSync(path)) return DEFAULT_MAPPING;
  const overrides = JSON.parse(readFileSync(path, 'utf8'));
  return {
    ...DEFAULT_MAPPING, ...overrides,
    columns: { ...DEFAULT_MAPPING.columns, ...(overrides.columns ?? {}) },
    sections: { ...DEFAULT_MAPPING.sections, ...(overrides.sections ?? {}) },
    permanentSiteBranches: { ...DEFAULT_MAPPING.permanentSiteBranches, ...(overrides.permanentSiteBranches ?? {}) },
  };
}
