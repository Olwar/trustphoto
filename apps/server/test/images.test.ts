/**
 * The public copy must be upright for every EXIF orientation, also when the
 * image library cannot read the photo's EXIF block.
 *
 * An Android photo from expo-camera (`exif: true`) arrives with the pixels as
 * the sensor gave them, the rotation only in the EXIF orientation tag, and
 * thumbnail pointers (tags 0x201 / 0x202) copied from the camera's own file
 * that point at nothing after the re-encode. libvips then drops the whole
 * EXIF block, so `sharp().rotate()` left such photos sideways.
 */

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { inspectImage, makePublicImages, phashOf } from '../src/images.js';

const W = 80;
const H = 40;

/** Four colour blocks, so each corner tells where it came from. */
async function quadrants(): Promise<Buffer> {
  const block = (color: string) => sharp({ create: { width: W / 2, height: H / 2, channels: 3, background: color } }).png().toBuffer();
  const [red, green, blue, white] = await Promise.all(['#ff0000', '#00ff00', '#0000ff', '#ffffff'].map(block));
  return sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } })
    .composite([
      { input: red, left: 0, top: 0 },
      { input: green, left: W / 2, top: 0 },
      { input: blue, left: 0, top: H / 2 },
      { input: white, left: W / 2, top: H / 2 },
    ])
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/** The EXIF block Android writes: dangling thumbnail pointers before the orientation tag. */
function androidExif(orientation: number): Buffer {
  const entries: Array<[tag: number, type: number, value: number]> = [
    [0x0201, 4, 5000], // JPEGInterchangeFormat: an offset past the end of the block
    [0x0202, 4, 9000], // JPEGInterchangeFormatLength
    [0x0112, 3, orientation],
  ];
  const ifd = Buffer.alloc(2 + 12 * entries.length + 4);
  ifd.writeUInt16BE(entries.length, 0);
  entries.forEach(([tag, type, value], i) => {
    const at = 2 + 12 * i;
    ifd.writeUInt16BE(tag, at);
    ifd.writeUInt16BE(type, at + 2);
    ifd.writeUInt32BE(1, at + 4);
    if (type === 3) ifd.writeUInt16BE(value, at + 8);
    else ifd.writeUInt32BE(value, at + 8);
  });
  const body = Buffer.concat([Buffer.from('Exif\0\0MM\0*\0\0\0\x08', 'latin1'), ifd]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/** As Android does: the EXIF segment goes right after the start-of-image marker. */
const withAndroidExif = (jpeg: Buffer, orientation: number) => Buffer.concat([jpeg.subarray(0, 2), androidExif(orientation), jpeg.subarray(2)]);

type Corner = 'red' | 'green' | 'blue' | 'white' | 'other';

async function corners(image: Buffer): Promise<{ width: number; height: number; corners: Corner[] }> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const name = (x: number, y: number): Corner => {
    const at = (y * info.width + x) * info.channels;
    const [r, g, b] = [data[at] > 128, data[at + 1] > 128, data[at + 2] > 128];
    if (r && g && b) return 'white';
    if (r && !g && !b) return 'red';
    if (!r && g && !b) return 'green';
    if (!r && !g && b) return 'blue';
    return 'other';
  };
  const [x1, y1] = [info.width - 5, info.height - 5];
  // top-left, top-right, bottom-left, bottom-right
  return { width: info.width, height: info.height, corners: [name(4, 4), name(x1, 4), name(4, y1), name(x1, y1)] };
}

describe('the public copy is upright', () => {
  it('turns an Android photo with orientation 6 a quarter turn clockwise', async () => {
    const { display, preview, width, height } = await makePublicImages(withAndroidExif(await quadrants(), 6));
    expect([width, height]).toEqual([H, W]);
    // The left column of the sensor image becomes the top row.
    expect((await corners(display)).corners).toEqual(['blue', 'red', 'white', 'green']);
    expect(await corners(preview)).toMatchObject({ width: H, height: W, corners: ['blue', 'red', 'white', 'green'] });
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('orientation %i gives the same picture as a photo whose EXIF the image library can read', async (orientation) => {
    const pixels = await quadrants();
    // The reference: a standard EXIF block, turned by the image library itself.
    const standard = await sharp(pixels).withMetadata({ orientation }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
    const expected = await corners(await sharp(standard).rotate().png().toBuffer());

    expect(await corners((await makePublicImages(withAndroidExif(pixels, orientation))).display)).toEqual(expected);
    expect(await corners((await makePublicImages(standard)).display)).toEqual(expected);
  });

  it('gives a sideways Android photo the fingerprint of the upright picture', async () => {
    const pixels = await quadrants();
    const uprightCopy = await sharp(pixels).rotate(90).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
    expect(await phashOf(withAndroidExif(pixels, 6))).toBe(await phashOf(uprightCopy));
  });

  it('carries no metadata', async () => {
    const { display, preview } = await makePublicImages(withAndroidExif(await quadrants(), 6));
    for (const image of [display, preview]) {
      const meta = await sharp(image).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
    }
  });
});

/**
 * The first look at an upload runs before the device check, so a free install
 * token reaches it. The image library reads a JPEG header with tens of
 * thousands of marker segments very slowly (seconds for a 100 kB file).
 */
describe('the first look at an upload', () => {
  const emptySegments = (count: number) => Buffer.concat(Array.from({ length: count }, () => Buffer.from([0xff, 0xe1, 0x00, 0x02])));

  it('accepts a camera JPEG, also with the EXIF block Android writes', async () => {
    const jpeg = await quadrants();
    expect(await inspectImage(jpeg)).toEqual({ format: 'jpeg', width: W, height: H });
    expect(await inspectImage(withAndroidExif(jpeg, 6))).toEqual({ format: 'jpeg', width: W, height: H });
  });

  it('accepts fill bytes before a marker, which the JPEG format permits', async () => {
    const jpeg = await quadrants();
    const padded = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xff]), jpeg.subarray(2)]);
    expect(await inspectImage(padded)).toEqual({ format: 'jpeg', width: W, height: H });
  });

  it('refuses a JPEG with thousands of header segments, without the slow read', async () => {
    const jpeg = await quadrants();
    const hostile = Buffer.concat([jpeg.subarray(0, 2), emptySegments(20_000), jpeg.subarray(2)]);
    const started = performance.now();
    expect(await inspectImage(hostile)).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('refuses a JPEG with loose bytes between its header segments', async () => {
    const jpeg = await quadrants();
    const loose = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0x00, 0x01, 0x02]), emptySegments(20_000), jpeg.subarray(2)]);
    expect(await inspectImage(loose)).toBeNull();
  });

  it('refuses a JPEG that ends before its picture data', async () => {
    const jpeg = await quadrants();
    expect(await inspectImage(jpeg.subarray(0, 40))).toBeNull();
  });

  it('refuses a file that is not a JPEG', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
    expect(await inspectImage(png)).toBeNull();
    expect(await inspectImage(Buffer.from('not an image'))).toBeNull();
    expect(await inspectImage(Buffer.alloc(0))).toBeNull();
  });
});
