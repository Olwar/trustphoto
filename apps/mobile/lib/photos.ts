/**
 * "My photos": the server is the source of truth; a small JSON copy on disk
 * makes the list show at once on the next launch, also offline.
 */

import { useSyncExternalStore } from 'react';
import { File, Paths } from 'expo-file-system';
import type { PublicPhoto } from '@trustphoto/shared';
import { apiFetch } from './api';
import { withInstall } from './install';
import { fetchAllPages } from './paging';

interface State {
  photos: PublicPhoto[];
  /** The list came from the server at least once in this session. */
  synced: boolean;
}

let state: State = { photos: [], synced: false };
/** Photos added while a refresh runs: the refresh's older list must not drop them. */
const addedAt = new Map<string, number>();
const listeners = new Set<() => void>();
const cacheFile = () => new File(Paths.document, 'photos.json');

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
  try {
    cacheFile().write(JSON.stringify(state.photos));
  } catch {
    // The cache is only a convenience.
  }
}

function loadCache(): void {
  try {
    const file = cacheFile();
    if (file.exists) state = { ...state, photos: JSON.parse(file.textSync()) as PublicPhoto[] };
  } catch {
    // Start empty.
  }
}
loadCache();

export function usePhotos(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** All of this install's photos, every page, so the owner can open and delete each one. */
export async function refreshPhotos(): Promise<void> {
  const startedAt = Date.now();
  const fetched = await withInstall((install) =>
    fetchAllPages(async (after) => {
      const page = await apiFetch<{ photos: PublicPhoto[]; next: string | null }>(
        `/v1/me/photos${after ? `?after=${encodeURIComponent(after)}` : ''}`,
        { token: install.token },
      );
      return { items: page.photos, next: page.next };
    }),
  );
  const missing = state.photos.filter((p) => (addedAt.get(p.id) ?? 0) >= startedAt && !fetched.some((f) => f.id === p.id));
  for (const [id, at] of addedAt) if (at < startedAt) addedAt.delete(id);
  set({ photos: [...missing, ...fetched], synced: true });
}

export function addPhoto(photo: PublicPhoto): void {
  addedAt.set(photo.id, Date.now());
  set({ photos: [photo, ...state.photos.filter((p) => p.id !== photo.id)] });
}

export async function deletePhoto(id: string): Promise<void> {
  await withInstall((install) => apiFetch(`/v1/me/photos/${encodeURIComponent(id)}`, { method: 'DELETE', token: install.token }));
  set({ photos: state.photos.filter((p) => p.id !== id) });
}
