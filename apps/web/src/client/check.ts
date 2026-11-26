/**
 * "Check a photo": the browser makes fingerprints of the chosen file (its
 * SHA-256, its pHash and codes of its fine detail) and sends only those. The
 * photo never leaves the device. The steps are in packages/shared/src/copycheck.ts.
 */

import { checkFile, type CheckOutcome } from '@trustphoto/shared/copycheck';
import { FEATURE_INPUT_MAX, grayFromPixels, type Gray } from '@trustphoto/shared/features';
import { lumaGrid, PHASH_SIZE } from '@trustphoto/shared/phash';
import type { LookupResult, PublicPhoto } from '@trustphoto/shared/protocol';
import { icon, type IconName } from '../icons';
import { formatLocal } from './time';

const drop = document.getElementById('drop') as HTMLLabelElement | null;
const input = document.getElementById('file') as HTMLInputElement | null;
const result = document.getElementById('result') as HTMLDivElement | null;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

let previewUrl: string | null = null;
let lastFile: File | null = null;
let busy = false;
/** A file chosen while a check ran: it is checked next, so a result never reads as the answer for another file. */
let waiting: File | null = null;

/** The file could not be decoded or hashed (not a server problem). */
class UnreadableFile extends Error {}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** TrustPhoto answered, but not with a result (the status says why). */
class ServerError extends Error {
  constructor(readonly status: number) {
    super(`status ${status}`);
  }
}
/** No answer at all: no connection. */
class Unreachable extends Error {}

/** Halves the image until it is near the target, then draws it at the target: an antialiased resize close to the server's. */
function drawSmall(bitmap: ImageBitmap, width: number, height: number): ImageData {
  let source: CanvasImageSource = bitmap;
  let w = bitmap.width;
  let h = bitmap.height;
  while (w >= width * 4 && h >= height * 4) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    const step = document.createElement('canvas');
    step.width = w;
    step.height = h;
    const sctx = step.getContext('2d');
    if (!sctx) throw new Error('no 2d context');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(source, 0, 0, w, h);
    source = step;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** The file as a grey picture at a long side of at most FEATURE_INPUT_MAX, for the fine-detail steps. */
function fullGray(bitmap: ImageBitmap): Gray {
  const k = Math.min(1, FEATURE_INPUT_MAX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * k));
  const height = Math.max(1, Math.round(bitmap.height * k));
  return grayFromPixels(drawSmall(bitmap, width, height).data, width, height, 4);
}

async function post(path: string, body: unknown): Promise<LookupResult> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Unreachable();
  }
  if (!res.ok) throw new ServerError(res.status);
  return (await res.json()) as LookupResult;
}

/** Lets the browser paint before a step that keeps it busy. A tab in the background gets no animation frame, so a timer ends the wait. */
const nextPaint = (): Promise<void> =>
  new Promise((resolve) => {
    const fallback = setTimeout(resolve, 150);
    requestAnimationFrame(() => {
      clearTimeout(fallback);
      setTimeout(resolve, 0);
    });
  });

async function lookFor(file: File, onSlowStep: () => void): Promise<CheckOutcome> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new UnreadableFile();
  }
  try {
    let sha256: string;
    let luma: Float64Array;
    try {
      sha256 = await sha256Hex(await file.arrayBuffer());
      luma = lumaGrid(drawSmall(bitmap, PHASH_SIZE, PHASH_SIZE).data, 4);
    } catch {
      throw new UnreadableFile();
    }
    return await checkFile({ sha256, luma, full: () => fullGray(bitmap) }, post, async () => {
      onSlowStep();
      await nextPaint();
    });
  } finally {
    bitmap.close();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(name: IconName, text: string, kind: string): HTMLElement {
  const p = el('p', `badge ${kind}`);
  p.insertAdjacentHTML('afterbegin', icon(name).value);
  p.append(` ${text}`);
  return p;
}

/** A thumbnail at the photo's own shape; a tap opens it full size, so small edits can be found. */
function thumb(src: string, caption: string): HTMLElement {
  const figure = el('figure', 'thumb');
  const link = el('a');
  link.href = src;
  link.target = '_blank';
  link.rel = 'noopener';
  link.setAttribute('aria-label', `${caption}, open full size`);
  const img = el('img');
  img.src = src;
  img.alt = caption;
  link.append(img);
  figure.append(link, el('figcaption', undefined, caption));
  return figure;
}

function openButton(photo: PublicPhoto, similar: boolean): HTMLAnchorElement {
  const label = photo.isTest ? 'Open the test proof' : similar ? 'Open the original proof' : 'Open the proof';
  const a = el('a', 'button button-primary', label);
  a.href = `/p/${encodeURIComponent(photo.id)}${similar ? '?from=similar' : ''}`;
  return a;
}

function show(...children: HTMLElement[]): void {
  if (!result) return;
  const card = el('div', 'result-card');
  card.append(...children);
  result.replaceChildren(card);
}

function render({ result: lookup, mirrored }: CheckOutcome): void {
  if (lookup.match === 'none' && lookup.unclear) {
    show(
      badge('search', 'Could not compare', 'badge-muted'),
      el('p', 'result-title', 'TrustPhoto could not compare this photo.'),
      el('p', 'result-text', 'A photo in TrustPhoto may be like it, but there is too little detail to compare, as in a photo of a plain wall or a clear sky. This does not mean that the photo is fake.'),
    );
    return;
  }
  if (lookup.match !== 'exact' && lookup.match !== 'similar') {
    show(
      badge('search', 'No proof found', 'badge-muted'),
      el('p', 'result-title', 'TrustPhoto has no proof for this photo.'),
      el('p', 'result-text', 'This does not mean that the photo is fake. Maybe nobody took it in TrustPhoto. Maybe someone changed it a lot, or its proof was removed.'),
    );
    return;
  }
  const { photo } = lookup;
  const when = `Received ${formatLocal(photo.receivedAt)}`;
  if (lookup.match === 'exact') {
    show(
      photo.isTest ? badge('info', 'Test proof', 'badge-test') : badge('seal', 'Verified', 'badge-verified'),
      el('p', 'result-title', photo.isTest ? 'This file matches a test proof. It is not a real proof.' : 'This file matches the verified photo.'),
      el('p', 'result-text', when),
      openButton(photo, false),
    );
    return;
  }
  const pair = el('div', 'pair');
  pair.append(thumb(previewUrl ?? '', 'Your file'), thumb(photo.imageUrl, photo.isTest ? 'Test proof photo' : 'Verified photo'));
  // How the file sits against the photo: a part of it, with more around it, mirrored, turned.
  const shape = lookup.shape;
  const part = shape !== undefined && shape.ofPhoto < 0.9;
  const inside = shape !== undefined && shape.ofFile < 0.8;
  const turned = shape !== undefined && shape.rotation > 10 && shape.rotation < 350;
  const proof = photo.isTest ? 'test proof' : 'verified photo';
  const badgeText = inside ? `Contains what looks like a ${proof}` : part ? `Looks like a part of a ${proof}` : `Looks like a ${proof}`;
  // A test proof has no verified file, so its title does not speak of one.
  const title = photo.isTest
    ? `${inside ? 'A part of this file looks like a test proof.' : part ? 'This looks like a part of a test proof.' : 'This looks like a test proof.'} A test proof is not a real proof.`
    : inside
      ? 'This is not the verified file. A part of it looks like a verified photo.'
      : part
        ? 'This is not the verified file. It looks like a part of a verified photo.'
        : 'This is not the verified file. It looks like a verified photo.';
  // The notes say how the match sits. They do not say that the file is the photo: an edited copy can match too.
  const notes: string[] = [];
  if (inside) notes.push('The proof is for that photo only. It is not for the text or the page around it.');
  if (part && shape) notes.push(`The part that matches is about ${Math.max(1, Math.round(shape.ofPhoto * 100))}% of the ${proof}.`);
  if (mirrored) notes.push('Your file looks like a mirror image: left and right are swapped.');
  if (turned && shape) {
    const side = (shape.rotation >= 45 && shape.rotation <= 135) || (shape.rotation >= 225 && shape.rotation <= 315);
    const how = side ? 'turned on its side' : shape.rotation > 135 && shape.rotation < 225 ? 'upside down' : 'tilted';
    notes.push(`Your file is ${how} compared with the ${proof}.`);
  }
  const caution = inside
    ? `The photo in your file can be a resized, compressed, cropped or edited copy. Compare it with the ${proof} before you trust it.`
    : 'It can be a resized, compressed, cropped or edited copy. Compare the two photos before you trust it.';
  show(
    photo.isTest ? badge('info', badgeText, 'badge-test') : badge('image', badgeText, 'badge-similar'),
    el('p', 'result-title', title),
    ...notes.map((note) => el('p', 'result-text', note)),
    el('p', 'result-text', caution),
    pair,
    el('p', 'result-text', 'Select a photo to see it full size.'),
    el('p', 'result-text', when),
    openButton(photo, true),
  );
}

function showError(message: string, retry: boolean): void {
  const children: HTMLElement[] = [badge('info', 'Could not check', 'badge-muted'), el('p', 'result-text', message)];
  if (retry && lastFile) {
    const button = el('button', 'button button-secondary', 'Try again');
    button.type = 'button';
    const file = lastFile;
    button.addEventListener('click', () => void check(file));
    children.push(button);
  }
  show(...children);
}

async function check(file: File): Promise<void> {
  if (busy) {
    waiting = file;
    return;
  }
  if (!ACCEPTED.includes(file.type)) {
    showError('Use a JPEG, PNG, WebP or AVIF photo.', false);
    return;
  }
  busy = true;
  lastFile = file;
  drop?.setAttribute('aria-busy', 'true');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  const spinner = el('div', 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const status = el('p', 'result-text', 'Checking the photo…');
  show(spinner, status);
  try {
    render(
      await lookFor(file, () => {
        // A crop, a mirror image or a screenshot needs a closer look, which takes some seconds.
        status.textContent = 'Looking closer. This can take a few seconds…';
      }),
    );
  } catch (err) {
    if (err instanceof UnreadableFile) showError('We could not read this file. Use another photo.', false);
    else if (err instanceof Unreachable) showError('We could not reach TrustPhoto. Check the connection and try again.', true);
    else if (err instanceof ServerError && err.status === 429) showError('Too many checks. Wait a minute and try again.', true);
    else if (err instanceof ServerError && err.status === 503) showError('TrustPhoto is busy. Try again in a minute.', true);
    else if (err instanceof ServerError) showError('TrustPhoto did not answer. Try again in a minute.', true);
    else showError('Something went wrong. Try again.', true);
  } finally {
    busy = false;
    drop?.removeAttribute('aria-busy');
    if (input) input.value = '';
    const next = waiting;
    waiting = null;
    if (next) void check(next);
  }
}

input?.addEventListener('change', () => {
  const file = input.files?.[0];
  if (file) void check(file);
});

drop?.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('is-over');
});
drop?.addEventListener('dragleave', () => drop.classList.remove('is-over'));
drop?.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('is-over');
  const file = e.dataTransfer?.files?.[0];
  if (file) void check(file);
});
// A file dropped beside the drop area, or while a check runs, must not make the browser open it in place of the page.
for (const type of ['dragover', 'drop'] as const) {
  document.addEventListener(type, (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
}
document.addEventListener('paste', (e) => {
  const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
  if (file) {
    drop?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    void check(file);
  }
});
