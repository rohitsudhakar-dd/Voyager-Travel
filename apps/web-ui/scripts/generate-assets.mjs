#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/**
 * Builds every image the app serves, so there is no remote stock photography,
 * no licensing question and nothing to imitate (04-STYLING.md § 4.3).
 *
 * The three hotel sizes are encoded independently rather than scaled in the
 * browser, because `frontend_heavy_assets` needs the large variant to cost
 * genuinely more bytes -- a data URI or an SVG would be the same weight at
 * every size and the LCP demo would prove nothing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '../public');

const HOTEL_VARIANTS = 16;
// Noise is what makes a variant expensive: deflate cannot squeeze it. The
// default (md) is kept nearly noise-free so the baseline LCP is honest, and lg
// is deliberately grainy so `frontend_heavy_assets` costs real bytes.
const SIZES = {
  sm: { width: 240, height: 180, noise: 0 },
  md: { width: 480, height: 360, noise: 0 },
  lg: { width: 960, height: 720, noise: 26 },
};

const AIRLINES = [
  { code: 'VG', hue: 212 },
  { code: 'NW', hue: 258 },
  { code: 'KE', hue: 172 },
  { code: 'SB', hue: 14 },
  { code: 'AR', hue: 196 },
  { code: 'CI', hue: 32 },
  { code: 'TQ', hue: 288 },
  { code: 'HV', hue: 148 },
];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, pixel) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const offset = rowStart + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function rng(seed) {
  let state = seed * 2654435761 || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** A seeded two-stop gradient with a geometric motif over it. */
function hotelPixel(variant, width, height, noise) {
  const random = rng(variant + 1);
  const hue = Math.floor(random() * 360);
  const hueShift = 28 + random() * 70;
  const bands = 3 + Math.floor(random() * 4);
  const diagonal = random() > 0.5;
  const motifRandom = rng(variant + 97);
  const circles = Array.from({ length: 4 }, () => ({
    cx: motifRandom(),
    cy: motifRandom(),
    r: 0.12 + motifRandom() * 0.22,
  }));
  const noiseRandom = rng(variant + 5_000);
  const noiseField = noise > 0 ? Array.from({ length: 4_096 }, () => noiseRandom() * 2 - 1) : null;

  return (x, y) => {
    const u = x / width;
    const v = y / height;
    const t = diagonal ? (u + v) / 2 : v;

    const [r1, g1, b1] = hslToRgb(hue, 0.42, 0.34);
    const [r2, g2, b2] = hslToRgb((hue + hueShift) % 360, 0.5, 0.62);

    let r = r1 + (r2 - r1) * t;
    let g = g1 + (g2 - g1) * t;
    let b = b1 + (b2 - b1) * t;

    // Banding motif.
    const band = Math.floor(v * bands);
    if (band % 2 === 0) {
      r *= 0.94;
      g *= 0.94;
      b *= 0.97;
    }

    // Overlapping discs.
    for (const circle of circles) {
      const dx = u - circle.cx;
      const dy = (v - circle.cy) * (height / width);
      if (dx * dx + dy * dy < circle.r * circle.r) {
        r = r * 0.82 + 34;
        g = g * 0.82 + 34;
        b = b * 0.82 + 40;
      }
    }

    if (noiseField) {
      const jitter = noiseField[((y * 131 + x * 17) % noiseField.length + noiseField.length) % noiseField.length] * noise;
      r += jitter;
      g += jitter;
      b += jitter;
    }

    return [clamp(r), clamp(g), clamp(b)];
  };
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function airlineSvg(code, hue) {
  const [r, g, b] = hslToRgb(hue, 0.5, 0.42);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" role="img" aria-label="${code}">
  <rect width="40" height="40" rx="10" fill="rgb(${r},${g},${b})"/>
  <path d="M8 26 L20 10 L32 26 L20 21 Z" fill="rgba(255,255,255,.92)"/>
  <text x="20" y="35" text-anchor="middle" font-family="system-ui, sans-serif" font-size="8" font-weight="700" fill="rgba(255,255,255,.92)">${code}</text>
</svg>
`;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="8" fill="#1d4ed8"/>
  <path d="M7 21 L16 7 L25 21 L16 17 Z" fill="#fff"/>
</svg>
`;

function write(relative, contents) {
  const target = resolve(publicDir, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

let bytes = 0;
for (let variant = 0; variant < HOTEL_VARIANTS; variant += 1) {
  for (const [size, { width, height, noise }] of Object.entries(SIZES)) {
    const png = encodePng(width, height, hotelPixel(variant, width, height, noise));
    write(`hotels/${variant}-${size}.png`, png);
    bytes += png.length;
  }
}

for (const { code, hue } of AIRLINES) {
  write(`airlines/${code}.svg`, airlineSvg(code, hue));
}

write('favicon.svg', FAVICON);

process.stdout.write(
  `generated ${HOTEL_VARIANTS * 3} hotel images (${(bytes / 1024 / 1024).toFixed(1)} MB), ${AIRLINES.length} carrier marks\n`,
);
