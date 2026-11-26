/** Follows `next` cursors until the server has no more pages (or `maxPages`, a guard against a looping cursor). */
export async function fetchAllPages<T>(
  fetchPage: (after: string | null) => Promise<{ items: T[]; next: string | null }>,
  maxPages = 200,
): Promise<T[]> {
  const all: T[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const { items, next } = await fetchPage(after);
    all.push(...items);
    if (!next || next === after) break;
    after = next;
  }
  return all;
}
