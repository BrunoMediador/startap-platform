import { Providers } from '@/components/providers';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';
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
  // Default escuro "Cadencia Noturna"; muda conforme o tema (1.C). A barra do
  // navegador acompanha o fundo da app no claro/escuro.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#14121C' },
    { media: '(prefers-color-scheme: light)', color: '#F4F2FB' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // data-theme default "dark" no SSR; o boot script (sincrono, antes do paint)
  // sobrescreve com a escolha persistida pra evitar flash (spec 1.C.1).
  return (
    <html
      lang="pt-BR"
      data-theme="dark"
      suppressHydrationWarning
      className={`${sora.variable} ${inter.variable}`}
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: script de boot sincrono e self-contained (THEME_BOOT_SCRIPT), sem input do usuario — necessario pra setar data-theme antes do paint e evitar FOUC (spec 1.C.1) */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
