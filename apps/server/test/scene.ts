import sharp from 'sharp';
import { captureFixtures } from './fixtures.js';

/** A drawn evening landscape, saved as a camera photo. Pleasant to look at in demo screenshots. */
export async function landscapePhoto(seed: number, takenAt: number, camera = { make: 'Google', model: 'Pixel 9 Pro' }): Promise<Buffer> {
  const W = 1600;
  const H = 1200;
  const hue = seed % 3;
  const sky = [['#1d3b5c', '#f08a4b', '#f7d08a'], ['#24324a', '#c86b85', '#f3c6a5'], ['#2b5876', '#8fb8d8', '#e8eef2']][hue];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset=".6" stop-color="${sky[1]}"/><stop offset="1" stop-color="${sky[2]}"/></linearGradient>
    <linearGradient id="h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a4a5c"/><stop offset="1" stop-color="#141b22"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#s)"/>
    <circle cx="${1000 + (seed % 5) * 60}" cy="640" r="110" fill="#fff4d8" opacity=".85"/>
    <path d="M0 820 C 300 640 520 760 760 690 S 1200 600 1600 740 V1200 H0Z" fill="#56667a"/>
    <path d="M0 950 C 360 860 640 940 920 880 S 1360 840 1600 900 V1200 H0Z" fill="url(#h)"/>
  </svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return captureFixtures().cameraJpeg({ data, width: info.width, height: info.height }, seed, takenAt, camera);
}

/**
 * A scene with many different shapes (no repeated pattern), saved as a
 * camera photo: the copy check needs corners that are not alike, as a real
 * photo has.
 */
export async function busyScene(seed: number, takenAt: number): Promise<Buffer> {
  const W = 1600;
  const H = 1200;
  let s = (seed * 2654435761) >>> 0 || 1;
  const r = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return ((s >>> 8) & 0xffff) / 0x10000;
  };
  const colour = (): string => `rgb(${Math.floor(30 + r() * 210)},${Math.floor(30 + r() * 210)},${Math.floor(30 + r() * 210)})`;
  const shapes: string[] = [];
  for (let i = 0; i < 170; i++) {
    const x = r() * W;
    const y = r() * H;
    const size = 30 + r() * 150;
    const turn = `rotate(${Math.floor(r() * 360)} ${x.toFixed(0)} ${y.toFixed(0)})`;
    const kind = Math.floor(r() * 4);
    if (kind === 0) shapes.push(`<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${size.toFixed(0)}" height="${(size * (0.3 + r())).toFixed(0)}" fill="${colour()}" transform="${turn}"/>`);
    else if (kind === 1) shapes.push(`<ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="${(size / 2).toFixed(0)}" ry="${(size * (0.2 + r() * 0.5)).toFixed(0)}" fill="${colour()}" transform="${turn}"/>`);
    else if (kind === 2) shapes.push(`<path d="M${x.toFixed(0)} ${y.toFixed(0)} l${(size * r()).toFixed(0)} ${(size * r()).toFixed(0)} l${(-size * r()).toFixed(0)} ${(size * r()).toFixed(0)}Z" fill="${colour()}" transform="${turn}"/>`);
    else shapes.push(`<path d="M${x.toFixed(0)} ${y.toFixed(0)} q${(size * (r() - 0.5)).toFixed(0)} ${(size * r()).toFixed(0)} ${size.toFixed(0)} ${(size * (r() - 0.5)).toFixed(0)}" stroke="${colour()}" stroke-width="${(4 + r() * 14).toFixed(0)}" fill="none"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${colour()}"/>${shapes.join('')}</svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().blur(1.2).raw().toBuffer({ resolveWithObject: true });
  return captureFixtures().cameraJpeg({ data, width: info.width, height: info.height }, seed, takenAt, { make: 'Google', model: 'Pixel 8' });
}
