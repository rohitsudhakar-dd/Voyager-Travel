/**
 * Local, deterministic imagery (04-STYLING.md § 10).
 *
 * Nothing renders from a third-party host and no real brand mark appears
 * anywhere. Airline "logos" are generated monograms; hotel photography is a
 * seeded procedural generator. Both are produced by scripts/generate-assets.mjs
 * at build time, which is also what gives `frontend_heavy_assets` something
 * genuinely heavy to serve.
 */

export type ImageSize = 'sm' | 'md' | 'lg';

/** Must stay in step with HOTEL_VARIANTS in scripts/generate-assets.mjs. */
export const HOTEL_IMAGE_VARIANTS = 16;

export const HOTEL_IMAGE_DIMENSIONS: Record<ImageSize, { width: number; height: number }> = {
  sm: { width: 240, height: 180 },
  md: { width: 480, height: 360 },
  lg: { width: 960, height: 720 },
};

export function hotelImageUrl(imageSeed: number, size: ImageSize): string {
  const variant = Math.abs(imageSeed) % HOTEL_IMAGE_VARIANTS;
  return `/hotels/${variant}-${size}.png`;
}

export function airlineLogoUrl(airlineCode: string): string {
  return `/airlines/${airlineCode.toUpperCase()}.svg`;
}

const MONOGRAM_HUES = [212, 258, 190, 340, 24, 150, 280, 4];

/**
 * Inline fallback for an airline code that had no file generated -- the
 * seeder's carrier list is not published, so an unknown code must still
 * render something stable rather than a broken image.
 */
export function airlineMonogramDataUrl(airlineCode: string): string {
  const code = airlineCode.toUpperCase().slice(0, 2);
  let hash = 0;
  for (let i = 0; i < code.length; i += 1) hash = (hash * 31 + code.charCodeAt(i)) % 9973;
  const hue = MONOGRAM_HUES[hash % MONOGRAM_HUES.length];
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" role="img">`,
    `<rect width="40" height="40" rx="8" fill="hsl(${hue} 62% 42%)"/>`,
    `<text x="20" y="26" font-family="Inter,sans-serif" font-size="16" font-weight="700"`,
    ` text-anchor="middle" fill="#ffffff">${code}</text></svg>`,
  ].join('');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
