import type { MetadataRoute } from 'next';

/**
 * Web App Manifest — servido pelo Next em /manifest.webmanifest e auto-linkado
 * no <head>. Icones 192/512 (maskable) sao o app-icon com conteiner escuro
 * (gerados por scripts/gen-icons.mjs a partir do appicon-constelacao.svg).
 * Tema unico escuro "Cadencia Noturna" (#14121C).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Startap · Portal do Cliente',
    short_name: 'Startap',
    description: 'Gerencie serviços, horários e o atendimento do seu assistente.',
    start_url: '/inicio',
    display: 'standalone',
    background_color: '#14121c',
    theme_color: '#14121c',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}
