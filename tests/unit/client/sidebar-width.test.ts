import { describe, expect, it } from 'vitest';
import {
  clampSidebarWidth,
  maxSidebarWidth,
  MIN_SIDEBAR_WIDTH,
} from '../../../client/src/sidebar-width.js';

describe('sessions sidebar width', () => {
  it('leaves room for the main workspace and respects its fixed maximum', () => {
    expect(maxSidebarWidth(1_600)).toBe(520);
    expect(maxSidebarWidth(900)).toBe(405);
    expect(maxSidebarWidth(600)).toBe(270);
    expect(maxSidebarWidth(400)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it('rounds and clamps dragged widths', () => {
    expect(clampSidebarWidth(100, 1_200)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(341.6, 1_200)).toBe(342);
    expect(clampSidebarWidth(800, 1_200)).toBe(520);
  });
});
