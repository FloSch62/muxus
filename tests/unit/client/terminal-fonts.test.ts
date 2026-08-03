import { describe, expect, it } from 'vitest';
import {
  terminalFontFamilies,
  terminalFontIsAvailable,
} from '../../../client/src/terminal/font-catalog.js';

describe('terminal font catalog', () => {
  it('combines bundled, installed and generic families without duplicates', () => {
    expect(
      terminalFontFamilies([
        'Ubuntu Mono',
        'DejaVu Sans Mono',
        'jetbrains mono',
        ' DejaVu Sans Mono ',
        '',
      ]),
    ).toEqual(['JetBrains Mono', 'DejaVu Sans Mono', 'Ubuntu Mono', 'monospace']);
  });

  it('reports unavailable selections only when enumeration succeeded', () => {
    expect(terminalFontIsAvailable('JetBrains Mono', [])).toBe(true);
    expect(terminalFontIsAvailable('"DejaVu Sans Mono"', ['DejaVu Sans Mono'])).toBe(true);
    expect(terminalFontIsAvailable('DejaVu Sans Mono', [])).toBe(false);
    expect(terminalFontIsAvailable('DejaVu Sans Mono', undefined)).toBeUndefined();
  });
});
