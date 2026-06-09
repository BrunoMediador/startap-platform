/**
 * Gera os PNGs de icone do portal a partir dos SVGs do kit de marca.
 * One-off: rode com `node scripts/gen-icons.mjs` quando o simbolo mudar.
 * Usa `sharp` (ja dependencia transitiva do Next). NAO roda no build.
 *
 * Saidas:
 *   src/app/apple-icon.png   180x180  (apple-touch-icon, convencao App Router)
 *   public/icon-192.png      192x192  (PWA)
 *   public/icon-512.png      512x512  (PWA maskable)
 * Origem: app-icon com conteiner escuro (springboard nunca some no wallpaper).
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="aiBg" cx="0.32" cy="0.26" r="0.9">
      <stop offset="0" stop-color="#241B3D"/>
      <stop offset="0.55" stop-color="#171327"/>
      <stop offset="1" stop-color="#100D1A"/>
    </radialGradient>
    <linearGradient id="aiLine" x1="320" y1="150" x2="170" y2="370" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#C4ABFA"/>
      <stop offset="1" stop-color="#6431D6"/>
    </linearGradient>
    <radialGradient id="aiGlow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#E0A23C" stop-opacity="0.5"/>
      <stop offset="0.55" stop-color="#E0A23C" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#E0A23C" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="115" fill="url(#aiBg)"/>
  <rect x="0.5" y="0.5" width="511" height="511" rx="114.5" fill="none"
        stroke="#9A7CF0" stroke-opacity="0.18" stroke-width="1"/>
  <g transform="translate(96,96) scale(5)">
    <path d="M44 17 L20 24 L44 40 L20 47" fill="none" stroke="url(#aiLine)"
          stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>
    <circle cx="20" cy="24" r="4.7" fill="#9A7CF0"/>
    <circle cx="44" cy="40" r="4.7" fill="#7E5CE8"/>
    <circle cx="20" cy="47" r="4.7" fill="#6431D6"/>
    <circle cx="44" cy="17" r="13" fill="url(#aiGlow)"/>
    <circle cx="44" cy="17" r="5.6" fill="#E0A23C"/>
    <circle cx="44" cy="17" r="2.1" fill="#F6D9A3"/>
  </g>
</svg>`;

const buf = Buffer.from(appIcon);
const targets = [
  { size: 180, out: join(root, 'src', 'app', 'apple-icon.png') },
  { size: 192, out: join(root, 'public', 'icon-192.png') },
  { size: 512, out: join(root, 'public', 'icon-512.png') },
];

mkdirSync(join(root, 'public'), { recursive: true });

for (const { size, out } of targets) {
  await sharp(buf, { density: 384 }).resize(size, size).png().toFile(out);
  console.log(`ok ${out} (${size}x${size})`);
}
