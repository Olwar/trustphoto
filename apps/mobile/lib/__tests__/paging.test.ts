import { describe, expect, it } from 'vitest';
import { fetchAllPages } from '../paging';

describe('fetchAllPages', () => {
  it('follows the cursor until the last page', async () => {
    const pages: Record<string, { items: number[]; next: string | null }> = {
      start: { items: [1, 2], next: 'a' },
      a: { items: [3, 4], next: 'b' },
      b: { items: [5], next: null },
    };
    const seen: (string | null)[] = [];
    const all = await fetchAllPages(async (after) => {
      seen.push(after);
      return pages[after ?? 'start'];
    });
    expect(all).toEqual([1, 2, 3, 4, 5]);
    expect(seen).toEqual([null, 'a', 'b']);
  });

  it('stops on a cursor that repeats', async () => {
    let calls = 0;
    await fetchAllPages(async () => {
      calls++;
      return { items: [calls], next: 'same' };
    });
    expect(calls).toBe(2);
  });
});
