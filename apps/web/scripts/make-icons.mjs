// Generates the three manifest icons in `public/icons/`.
//
// The PNGs are committed; this script exists so "why is the icon 4 px off" has an answer that is
// not "someone opened Figma once". It is not part of the build — nothing imports it, and `pnpm
// build` never runs it. Re-run it by hand after changing a colour or a shape:
//
//   node apps/web/scripts/make-icons.mjs
//
// Encoding a PNG by hand rather than adding `sharp` or `canvas`: three flat-colour icons do not
// justify a native dependency in a repository whose only job is to install cleanly on a laptop
// nobody has configured. `zlib` is in Node, and an 8-bit RGBA PNG is a header, one IDAT of
// filter-0 scanlines, and an IEND.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');

const BG = [0x17, 0x20, 0x1c]; // the `theme-color` in index.html
const CARD = [0xf5, 0xf7, 0xf5];
const ACCENT = [0x6e, 0xe7, 0xb7]; // `a.router-link-active` in styles.css

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** `pixels` is RGBA, row-major, `size * size * 4` bytes. */
function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One extra byte per scanline for the filter type, which is 0 (None) throughout — these are
  // flat shapes, so a smarter filter would buy bytes nobody is counting.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Draws the mark: a receipt with a torn bottom edge and three lines of "text".
 *
 * `inset` is the fraction of the canvas the background leaves around the card. A maskable icon
 * hands its outer 10% to the launcher's mask, so it is full-bleed (`corner: 0`) with a bigger
 * inset, leaving the mask a square to cut from; the `any` icon draws its own rounded square.
 */
function draw(size, { inset, corner }) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, [r, g, b]) => {
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 0xff;
  };

  const radius = corner * size;
  const inCorner = (x, y) => {
    const cx = Math.min(Math.max(x + 0.5, radius), size - radius);
    const cy = Math.min(Math.max(y + 0.5, radius), size - radius);
    return Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius;
  };

  const cardX0 = Math.round(size * inset);
  const cardX1 = size - cardX0;
  const cardY0 = Math.round(size * inset * 0.85);
  const cardY1 = size - cardY0;
  // The torn edge: a triangle wave whose period is a tenth of the card's width.
  const tooth = (cardX1 - cardX0) / 5;
  const tornTop = cardY1 - tooth * 0.5;

  const lineH = Math.max(2, Math.round(size * 0.045));
  const lines = [0.24, 0.44, 0.64].map((t) => Math.round(cardY0 + (tornTop - cardY0) * t));
  const lineX0 = cardX0 + Math.round((cardX1 - cardX0) * 0.16);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!inCorner(x, y)) continue; // transparent outside the rounded square
      put(x, y, BG);

      if (x < cardX0 || x >= cardX1 || y < cardY0 || y >= cardY1) continue;
      if (y >= tornTop) {
        // Distance up from the valley floor, sawing back and forth across the card.
        const phase = Math.abs((((x - cardX0) % tooth) / tooth) * 2 - 1);
        if (y >= tornTop + tooth * 0.5 * phase) continue;
      }
      put(x, y, CARD);

      const width = (i) => Math.round((cardX1 - cardX0) * (i === 2 ? 0.36 : 0.68));
      for (const [i, top] of lines.entries()) {
        if (y >= top && y < top + lineH && x >= lineX0 && x < lineX0 + width(i)) {
          put(x, y, i === 2 ? ACCENT : BG);
        }
      }
    }
  }
  return px;
}

mkdirSync(OUT, { recursive: true });
for (const [file, size, shape] of [
  ['icon-192.png', 192, { inset: 0.26, corner: 0.22 }],
  ['icon-512.png', 512, { inset: 0.26, corner: 0.22 }],
  ['icon-maskable-512.png', 512, { inset: 0.33, corner: 0 }],
]) {
  writeFileSync(resolve(OUT, file), encodePng(size, draw(size, shape)));
  process.stdout.write(`${file}\n`);
}
