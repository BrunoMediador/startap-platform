import { Providers } from '@/components/providers';
import type { Metadata, Viewport } from 'next';
import { Inter, Sora } from 'next/font/google';
import './globals.css';

// Sora (display) e Inter (body) via next/font — sem FOUT, display swap (spec 1.3).
const sora = Sora({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-sora',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
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
