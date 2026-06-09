import { Providers } from '@/components/providers';
import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';

// Sora (display) e Inter (body) auto-hospedadas via next/font/local — sem FOUT,
// display swap (spec 1.3). Os woff2 (subset latin, OFL-1.1) sao vendorados em
// ./fonts pra o build NAO depender do Google Fonts (ETIMEDOUT travava o deploy
// no VPS, que roda next build sem acesso confiavel a rede externa).
const sora = localFont({
  src: [
    { path: './fonts/sora-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/sora-latin-600-normal.woff2', weight: '600', style: 'normal' },
    { path: './fonts/sora-latin-700-normal.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sora',
  display: 'swap',
});

const inter = localFont({
  src: [
    { path: './fonts/inter-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/inter-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/inter-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Startap · Portal do Cliente',
  description: 'Gerencie serviços, horários e o atendimento do seu robô.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Tema unico escuro "Cadencia Noturna": a barra do navegador acompanha o
  // fundo da app (#14121C) sempre — nao ha mais opcao de tema claro.
  themeColor: '#14121C',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Tema unico escuro: data-theme="dark" fixo no <html> (blinda o CSS). Nao ha
  // mais escolha persistida nem boot script — o app e sempre Cadencia Noturna.
  return (
    <html lang="pt-BR" data-theme="dark" className={`${sora.variable} ${inter.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
