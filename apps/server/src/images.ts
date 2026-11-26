import exifr from 'exifr';
import sharp, { type Sharp, type SharpOptions } from 'sharp';
import { lumaGrid, PHASH_SIZE, phashFromLuma } from '@trustphoto/shared';
import { frameOf, storedCode, type StoredCode } from '@trustphoto/shared/copycheck';
import { grayFromPixels, resizeGray, type Gray } from '@trustphoto/shared/features';

/** Larger photos are refused before decoding: 50 MP is above every phone camera and bounds memory. */
export const MAX_PIXELS = 50_000_000;

/**
 * A camera JPEG has a few dozen marker segments before its picture data (a
 * typical phone camera JPEG: about 10). The image library reads a header with tens of
 * thousands of them very slowly: seconds for a 100 kB file.
 */
const MAX_HEADER_SEGMENTS = 500;

/**
 * True for a JPEG whose header is a clean chain of at most MAX_HEADER_SEGMENTS
 * marker segments that ends at the picture data. Plain byte reads, no library.
 */
function hasSaneJpegHeader(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let at = 2;
  for (let segments = 0; segments <= MAX_HEADER_SEGMENTS; segments++) {
    if (bytes[at] !== 0xff) return false;
    // Fill bytes before a marker are permitted.
    while (bytes[at + 1] === 0xff) at++;
    const marker = bytes[at + 1];
    if (marker === 0xda) return true; // start of scan: the picture data
    // Every other marker in a header has a length. A marker without one, or the end of the file, is not a camera JPEG.
    if (marker === undefined || marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) || at + 4 > bytes.length) return false;
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) return false;
    at += 2 + length;
  }
  return false;
}

/**
 * Header-only read: format and size, no pixel decode. Only a JPEG with a sane
 * header reaches the image library: this runs before the device check, so
 * anyone with a free install token can send bytes here.
 */
export async function inspectImage(bytes: Buffer): Promise<{ format: string | undefined; width: number; height: number } | null> {
  if (!hasSaneJpegHeader(bytes)) return null;
  try {
    const meta = await sharp(bytes).metadata();
    return { format: meta.format, width: meta.width ?? 0, height: meta.height ?? 0 };
  } catch {
    return null;
  }
}

/** Longest edge of the public copy. */
const DISPLAY_MAX = 4096;
/** Width of the link-preview image (Open Graph). */
const PREVIEW_WIDTH = 1200;

export interface PublicImages {
  /** The photo as the website serves it: upright, no metadata (so no GPS), full detail. */
  display: Buffer;
  preview: Buffer;
  width: number;
  height: number;
  phash: string;
  /** Search keys of the photo's local features, for cropped and turned copies. */
  code: StoredCode;
}

/**
 * The grey picture that a photo's search keys and detail bits refer to: the
 * photo at `frameOf` its size. Made from the preview file both when the photo
 * is stored and when a lookup is confirmed, so the two are the same picture.
 * The library only decodes: the grey values and the resize are the shared
 * code that the browser also runs on the checked file, so the two sides see
 * a copy the same way.
 */
export async function frameGray(preview: Buffer, width: number, height: number): Promise<Gray> {
  const { data, info } = await sharp(preview, { limitInputPixels: MAX_PIXELS }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded: Gray =
    info.channels === 1
      ? { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, info.width * info.height) }
      : grayFromPixels(data, info.width, info.height, 3);
  const frame = frameOf(width, height);
  return resizeGray(decoded, Math.min(frame.width, decoded.width), Math.min(frame.height, decoded.height));
}

/**
 * The verified original keeps its EXIF (GPS included) only in memory. The
 * public copy is rotated upright from the EXIF orientation and written
 * without any metadata.
 */
export async function makePublicImages(original: Buffer): Promise<PublicImages> {
  const upright = await uprightImage(original, { failOn: 'error', limitInputPixels: MAX_PIXELS });
  const { data: display, info } = await upright
    .clone()
    .resize({ width: DISPLAY_MAX, height: DISPLAY_MAX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true });
  const preview = await upright.clone().resize({ width: PREVIEW_WIDTH, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  const code = storedCode(await frameGray(preview, info.width, info.height));
  return { display, preview, width: info.width, height: info.height, phash: await phashOf(display), code };
}

/**
 * The EXIF orientation (1 to 8). exifr reads it first: libvips drops the whole
 * EXIF block of an Android photo from expo-camera, because Android copies the
 * thumbnail pointers of the camera's file into the re-encoded file, where they
 * point at nothing. sharp then sees no orientation and leaves the photo sideways.
 */
async function orientationOf(image: Buffer): Promise<number> {
  const fromExif = await exifr.orientation(image).catch(() => undefined);
  if (typeof fromExif === 'number' && Number.isInteger(fromExif) && fromExif >= 1 && fromExif <= 8) return fromExif;
  const fromLibrary = (await sharp(image, { limitInputPixels: MAX_PIXELS }).metadata().catch(() => null))?.orientation;
  return fromLibrary && fromLibrary >= 1 && fromLibrary <= 8 ? fromLibrary : 1;
}

/** A pipeline that gives the picture upright. sharp mirrors first and turns after that, in any call order. */
async function uprightImage(image: Buffer, options: SharpOptions): Promise<Sharp> {
  const pipeline = sharp(image, options);
  switch (await orientationOf(image)) {
    case 2:
      return pipeline.flop();
    case 3:
      return pipeline.rotate(180);
    case 4:
      return pipeline.flip();
    case 5:
      return pipeline.flop().rotate(270);
    case 6:
      return pipeline.rotate(90);
    case 7:
      return pipeline.flop().rotate(90);
    case 8:
      return pipeline.rotate(270);
    default:
      return pipeline;
  }
}

/** pHash of an image file, decoded upright, the same way the website does it in the browser. */
export async function phashOf(image: Buffer): Promise<string> {
  const { data } = await (await uprightImage(image, { limitInputPixels: MAX_PIXELS }))
    .resize(PHASH_SIZE, PHASH_SIZE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return phashFromLuma(lumaGrid(data, 3));
}
