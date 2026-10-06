import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { AUTH_BRAND_PALETTE } from '../features/auth/brand-palette';
import { brandMarkGeometry } from '../ui/components/brand-mark/brand-mark-geometry';

setupRitewayBun();

const { accent, accentInk } = AUTH_BRAND_PALETTE.light;
const { size, cornerRadius, discRadius } = brandMarkGeometry;
const centre = size / 2;

const file = (name: string) => readFileSync(new URL(name, import.meta.url));

type Rgb = readonly [number, number, number];
const rgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

/** Each ICO directory entry: its pixel size and its embedded PNG bytes. */
const icoImages = (ico: Buffer) =>
  Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
    const entry = 6 + index * 16;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    return {
      size: ico[entry] === 0 ? 256 : (ico[entry] ?? 0),
      png: ico.subarray(offset, offset + length),
    };
  });

/** One RGB pixel of an 8-bit RGBA, unfiltered, non-interlaced PNG. */
const pixel = (png: Buffer, x: number, y: number): Rgb => {
  const width = png.readUInt32BE(16);
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT')
      chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const start = y * (1 + width * 4) + 1 + x * 4;
  return [raw[start] ?? -1, raw[start + 1] ?? -1, raw[start + 2] ?? -1];
};

describe('app icons', () => {
  test('icon.svg is the brand mark in the light palette', () => {
    assert({
      given: 'the file-convention icon',
      should:
        'draw the shared mark geometry with the accent square and accent-ink disc, and nothing else',
      actual: file('icon.svg').toString('utf8').trim(),
      expected: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${cornerRadius}" fill="${accent}"/><circle cx="${centre}" cy="${centre}" r="${discRadius}" fill="${accentInk}"/></svg>`,
    });
  });

  test('favicon.ico carries the same mark at 16 and 32 px', () => {
    const images = icoImages(file('favicon.ico'));
    assert({
      given:
        'the fallback favicon that pages without a <link rel="icon"> fetch',
      should:
        'hold a 16 and a 32 px PNG, each with an accent-ink centre and an accent edge',
      actual: images.map(({ size: px, png }) => ({
        px,
        png: png.toString('latin1', 1, 4),
        centre: pixel(png, px / 2, px / 2),
        edge: pixel(png, px / 2, 1),
      })),
      expected: [16, 32].map((px) => ({
        px,
        png: 'PNG',
        centre: rgb(accentInk),
        edge: rgb(accent),
      })),
    });
  });
});
