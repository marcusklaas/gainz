// Generates the app icons and the favicon. Run with `npm run icons` after
// changing the artwork or the palette in style.css; everything it writes into
// icons/ is committed.
//
// The artwork is tools/biceps.svg — a line drawing of the flexed-bicep emoji.
// It is an autotrace, so the ink is filled outlines rather than strokes: the
// path is the boundary of the line, not the line. That is why this file
// rasterises by filling rather than by stroking, and it is also why the drawing
// cannot simply be given a thicker pen at small sizes. See `grow` below.
//
// Everything here is hand-rolled to keep the repo dependency-free: an SVG path
// parser, a cubic flattener, a scanline fill and a PNG writer. That is a lot of
// machinery for five files, but they are regenerated about once a year and the
// alternative is a build-time image toolchain.
import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const BG = [0x16, 0x18, 0x1c];
const LINE = [0x6b, 0xbf, 0x59];
const SS = 4; // supersampling factor
const SOURCE = new URL("biceps.svg", import.meta.url);

// ------------------------------------------------------------- svg artwork

/**
 * Enough of an SVG reader for one autotraced file: the viewBox, a single group
 * transform of the translate+scale form potrace emits, and the filled paths.
 * Anything else in a hand-edited file will be ignored rather than warned about,
 * so keep the source simple.
 */
function loadArtwork() {
  const text = readFileSync(SOURCE, "utf8");

  const box = /viewBox="([-\d.\s]+)"/.exec(text);
  if (!box) throw new Error("biceps.svg has no viewBox");
  const [, , w, h] = box[1].trim().split(/[\s,]+/).map(Number);

  const g = /<g[^>]*transform="translate\(([-\d.]+)[,\s]+([-\d.]+)\)\s*scale\(([-\d.]+)[,\s]+([-\d.]+)\)"/
    .exec(text);
  const [tx, ty, sx, sy] = g ? g.slice(1).map(Number) : [0, 0, 1, 1];

  const ds = [...text.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  if (!ds.length) throw new Error("biceps.svg has no paths");

  return {
    width: w,
    height: h,
    // The path data untouched, for re-emitting as an SVG.
    ds,
    transform: `translate(${tx},${ty}) scale(${sx},${sy})`,
    // And flattened into a 0..1 box, y pointing down, for the rasteriser.
    polygons: ds
      .flatMap(parsePath)
      .map((sub) => sub.map(([x, y]) => [(tx + x * sx) / w, (ty + y * sy) / h])),
  };
}

/**
 * Path data to polygons, one per subpath. Only the commands potrace produces
 * are implemented; an unknown one is skipped rather than guessed at, because
 * silently mis-drawing is worse than a visibly missing piece.
 */
function parsePath(d) {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  const subpaths = [];
  let pts = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let cmd = "";
  let i = 0;
  const num = () => Number(tokens[i++]);

  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;

    switch (cmd.toUpperCase()) {
      case "M":
        cx = ox + num();
        cy = oy + num();
        startX = cx;
        startY = cy;
        pts = [[cx, cy]];
        subpaths.push(pts);
        // Coordinate pairs that follow a moveto are linetos, per the spec.
        cmd = rel ? "l" : "L";
        break;
      case "L":
        cx = ox + num();
        cy = oy + num();
        pts.push([cx, cy]);
        break;
      case "H":
        cx = ox + num();
        pts.push([cx, cy]);
        break;
      case "V":
        cy = oy + num();
        pts.push([cx, cy]);
        break;
      case "C": {
        const x1 = ox + num();
        const y1 = oy + num();
        const x2 = ox + num();
        const y2 = oy + num();
        const x = ox + num();
        const y = oy + num();
        flattenCubic(pts, cx, cy, x1, y1, x2, y2, x, y);
        cx = x;
        cy = y;
        break;
      }
      case "Z":
        pts.push([startX, startY]);
        cx = startX;
        cy = startY;
        break;
      default:
        i++;
    }
  }
  return subpaths.filter((p) => p.length > 2);
}

/** Subdivided by control-polygon length, so long sweeps get more segments than
 *  the little curls in the fist. */
function flattenCubic(out, x0, y0, x1, y1, x2, y2, x3, y3) {
  const span = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
  const n = Math.min(96, Math.max(3, Math.ceil(span / 15)));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const u = 1 - t;
    out.push([
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    ]);
  }
}

// -------------------------------------------------------------- rasteriser

/**
 * Scanline fill, non-zero winding — which is what makes the hole inside the arm
 * a hole: the trace runs its inner boundary the opposite way round from the
 * outer one, and the windings cancel.
 */
function fill(polygons, size) {
  const cov = new Float32Array(size * size);
  const edges = [];
  for (const poly of polygons) {
    for (let i = 0; i < poly.length - 1; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[i + 1];
      if (ay !== by) edges.push([ax, ay, bx, by]);
    }
  }

  const hits = [];
  for (let y = 0; y < size; y++) {
    const yc = y + 0.5;
    hits.length = 0;
    for (const [ax, ay, bx, by] of edges) {
      if (ay <= yc ? by <= yc : by > yc) continue; // no crossing of this row
      hits.push([ax + ((yc - ay) / (by - ay)) * (bx - ax), by > ay ? 1 : -1]);
    }
    if (!hits.length) continue;
    hits.sort((a, b) => a[0] - b[0]);

    let winding = 0;
    for (let i = 0; i < hits.length - 1; i++) {
      winding += hits[i][1];
      if (winding === 0) continue;
      const from = Math.max(0, Math.ceil(hits[i][0] - 0.5));
      const to = Math.min(size - 1, Math.ceil(hits[i + 1][0] - 0.5) - 1);
      for (let x = from; x <= to; x++) cov[y * size + x] = 1;
    }
  }
  return cov;
}

/**
 * Square dilation, separable so it stays cheap. The source lines are about two
 * hundredths of the box wide, which is a hairline once the icon is 64px across
 * and gone entirely by 32. Fattening the ink is the only way to keep a filled
 * drawing legible when it is shrunk.
 */
function dilate(cov, size, radius) {
  if (radius < 1) return cov;
  const pass = (src) => {
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        for (let d = -radius; d <= radius; d++) {
          const xx = x + d;
          if (xx >= 0 && xx < size && src[y * size + xx]) {
            out[y * size + x] = 1;
            break;
          }
        }
      }
    }
    return out;
  };
  // Transposing between the two passes lets one horizontal kernel do both.
  const transpose = (src) => {
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[x * size + y] = src[y * size + x];
    return out;
  };
  return transpose(pass(transpose(pass(cov))));
}

/**
 * `inset` shrinks the artwork towards the centre. Maskable icons need it
 * because Android crops to an arbitrary shape and only the middle 80% is
 * guaranteed to survive. `grow` fattens the ink, in output pixels. `transparent`
 * drops the background and hands the coverage over as alpha instead, which only
 * the favicon wants — a home-screen icon with holes in it looks broken.
 */
function icon(polygons, { size, inset = 1, grow = 0, transparent = false }) {
  const big = size * SS;
  const place = ([x, y]) => [
    big * (0.5 + (x - 0.5) * inset),
    big * (0.5 + (y - 0.5) * inset),
  ];
  const cov = dilate(fill(polygons.map((p) => p.map(place)), big), big, Math.round(grow * SS));

  return png(size, transparent, (x, y) => {
    let sum = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) sum += cov[(y * SS + dy) * big + (x * SS + dx)];
    }
    const a = sum / (SS * SS);
    // Transparent keeps the ink at full strength and varies alpha; opaque bakes
    // the same blend against the background instead.
    return transparent
      ? [...LINE, Math.round(a * 255)]
      : BG.map((c, i) => Math.round(c + (LINE[i] - c) * a));
  });
}

// --------------------------------------------------------------------- png

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

function png(size, alpha, sample) {
  const channels = alpha ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // colour type: truecolour, with or without alpha
  // Each scanline is prefixed with its filter byte; 0 means "store as-is".
  const stride = size * channels + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const px = sample(x, y);
      for (let c = 0; c < channels; c++) raw[row + 1 + x * channels + c] = px[c];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------------- svg

const hex = (rgb) => "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");

/**
 * The source artwork recoloured, for tabs that take an SVG. Backgroundless to
 * match favicon.png — this is the icon most browsers actually use, so a dark
 * plate here would make the PNG's transparency pointless.
 *
 * The original curves are passed through rather than the flattened polygons:
 * the two differ by well under a pixel, and re-emitting the flattened version
 * costs fifty kilobytes for a favicon.
 */
function svg(art) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${art.width} ${art.height}">
<g transform="${art.transform}" fill="${hex(LINE)}">
${art.ds.map((d) => `<path d="${d}"/>`).join("\n")}
</g>
</svg>
`;
}

// -------------------------------------------------------------------- main

const art = loadArtwork();
mkdirSync("icons", { recursive: true });

// Only the small sizes need the ink fattened; 192 and up carry the hairline as
// drawn.
const out = {
  "icons/icon-192.png": { size: 192 },
  "icons/icon-512.png": { size: 512 },
  // Android maskable, and iOS which rounds the corners itself.
  "icons/icon-maskable-512.png": { size: 512, inset: 0.62 },
  "icons/apple-touch-icon.png": { size: 180, inset: 0.82, grow: 0.5 },
  // Browser tab, for anything that will not take the SVG. Alone among these it
  // sits on the browser's chrome rather than on a home screen, so it keeps no
  // background of its own and wears the ink lighter to suit.
  "icons/favicon.png": { size: 64, grow: 0.25, transparent: true },
};
for (const [file, opts] of Object.entries(out)) {
  writeFileSync(file, icon(art.polygons, opts));
  console.log(`${file}  ${opts.size}x${opts.size}`);
}
writeFileSync("icons/icon.svg", svg(art));
console.log("icons/icon.svg");
