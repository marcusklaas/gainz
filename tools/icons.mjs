// Generates the PWA icons. Run with `npm run icons` after changing the palette
// in style.css; the PNGs it writes are committed.
//
// Hand-rolled PNG writing keeps this dependency-free: an icon is a solid
// background plus one stroked polyline, which is a few lines of pixel maths.
// Everything is drawn at 4x and box-filtered down, which is the whole
// antialiasing story.
import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const BG = [0x16, 0x18, 0x1c];
const LINE = [0x6b, 0xbf, 0x59];
const SS = 4; // supersampling factor

// A rising trend line, in a 0..1 box with y pointing up.
const PATH = [
  [0.10, 0.24],
  [0.37, 0.53],
  [0.60, 0.41],
  [0.90, 0.82],
];

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

function png(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour, no alpha (icons are always opaque)
  // Each scanline is prefixed with its filter byte; 0 means "store as-is".
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = rgb(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Shortest distance from a point to a line segment. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  // Clamping t to [0,1] is what gives the stroke its round caps and joins.
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * `inset` shrinks the artwork towards the centre. Maskable icons need it
 * because Android crops to an arbitrary shape and only the middle 80% is
 * guaranteed to survive.
 */
function icon(size, inset) {
  const big = size * SS;
  const stroke = big * 0.085 * inset;
  const place = (p) => [
    big * (0.5 + (p[0] - 0.5) * inset),
    big * (0.5 - (p[1] - 0.5) * inset),
  ];
  const pts = PATH.map(place);

  // Supersampled coverage: 1 inside the stroke, 0 outside.
  const cov = new Float32Array(big * big);
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      let d = Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
        d = Math.min(d, distToSegment(x + 0.5, y + 0.5, ...pts[i], ...pts[i + 1]));
      }
      if (d <= stroke / 2) cov[y * big + x] = 1;
    }
  }

  return png(size, (x, y) => {
    let sum = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) sum += cov[(y * SS + dy) * big + (x * SS + dx)];
    }
    const a = sum / (SS * SS);
    return BG.map((c, i) => Math.round(c + (LINE[i] - c) * a));
  });
}

mkdirSync("icons", { recursive: true });
const out = [
  ["icons/icon-192.png", 192, 1],
  ["icons/icon-512.png", 512, 1],
  // Android maskable, and iOS which rounds the corners itself.
  ["icons/icon-maskable-512.png", 512, 0.62],
  ["icons/apple-touch-icon.png", 180, 0.82],
];
for (const [file, size, inset] of out) {
  writeFileSync(file, icon(size, inset));
  console.log(`${file}  ${size}x${size}`);
}
