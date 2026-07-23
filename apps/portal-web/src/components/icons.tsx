/**
 * Icones SVG tracado (sem dependencia de lib runtime; copiados dos prototipos da
 * spec). Decorativos por design: `base()` injeta aria-hidden em TODOS, e os usos
 * funcionais sempre tem aria-label no elemento-pai (botoes/links). O
 * noSvgWithoutTitle e desligado para este arquivo via override no biome.json
 * (o aria-hidden vai no spread, fora do alcance da analise estatica do Biome).
 */
import { type SVGProps, useId } from 'react';

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function base({ size = 24, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
    ...props,
  } as SVGProps<SVGSVGElement>;
}

export function IconHome(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconServices(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M4 7h16M4 12h16M4 17h10"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconCalendar(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" strokeWidth={2} />
      <path d="M3 9h18M8 2v4M16 2v4" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

export function IconPause(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="6" y="5" width="4" height="14" rx="1.3" stroke="currentColor" strokeWidth={2} />
      <rect x="14" y="5" width="4" height="14" rx="1.3" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}

export function IconScissors(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M6 4v7a6 6 0 0 0 12 0V4M8 4h8"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconPencil(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
    </svg>
  );
}

export function IconX(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M5 12.5 10 17l9-10"
        stroke="currentColor"
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 5v14l11-7z" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" strokeWidth={2} />
      <path
        d="M4 16V6a2 2 0 0 1 2-2h10"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconLogout(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 8l-4 4 4 4M6 12h11"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path
        d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth={2} />
      <path
        d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.5a3.2 3.2 0 0 1 0 5M17 20a5.5 5.5 0 0 0-2-4.3"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconUser(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth={2} />
      <path
        d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" stroke="currentColor" strokeWidth={2} />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}

export function IconEye(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-3.3 3.9M6.2 8.2A16 16 0 0 0 2.5 12S6 18 12 18a9.4 9.4 0 0 0 3.4-.6M9.9 9.9a3 3 0 0 0 4.2 4.2"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={2} />
      <path d="M12 7v.5M12 11v6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth={2} />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="m15 6-6 6 6 6"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="m9 6 6 6-6 6"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={2} />
      <path
        d="M12 7.5V12l3 2"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * WhatsApp — item de menu "Conectar" e contexto da tela de conexao. Glifo do
 * balao + fone (tracado, herda currentColor; sem verde da marca pra casar com o
 * tema). Decorativo (aria-hidden via base) — o rotulo vive no link/botao-pai.
 */
export function IconWhatsapp(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M3.5 20.5 4.8 16A8 8 0 1 1 8 19.2l-4.5 1.3z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path
        d="M9 8.5c-.3 0-.6.1-.8.4-.3.3-.9.9-.9 2s.9 2.3 1 2.5c.1.2 1.7 2.7 4.2 3.6 2 .8 2.5.6 2.9.6.5-.1 1.4-.6 1.6-1.2.2-.6.2-1 .1-1.2-.1-.1-.3-.2-.6-.4-.3-.2-1.4-.7-1.6-.8-.2-.1-.4-.1-.6.1-.2.3-.6.8-.7 1-.1.1-.3.2-.5.1-.3-.1-1.1-.4-2-1.3-.7-.6-1.2-1.4-1.3-1.7-.1-.2 0-.4.1-.5l.4-.5c.1-.2.2-.3.3-.5 0-.2 0-.4-.1-.5-.1-.2-.6-1.4-.8-1.9-.2-.4-.4-.4-.6-.4h-.4z"
        fill="currentColor"
      />
    </svg>
  );
}

/** QR Code — alternativa de conexao por leitura (tela de conexao, estado f). */
export function IconQr(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="3.5" width="6" height="6" rx="1.2" stroke="currentColor" strokeWidth={2} />
      <rect x="14.5" y="3.5" width="6" height="6" rx="1.2" stroke="currentColor" strokeWidth={2} />
      <rect x="3.5" y="14.5" width="6" height="6" rx="1.2" stroke="currentColor" strokeWidth={2} />
      <path
        d="M14.5 14.5h2.5v2.5M20.5 14.5v6M14.5 20.5h2.5"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Recarregar/atualizar — atualizar QR, tentar de novo (tela de conexao). */
export function IconRefresh(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M20 11a8 8 0 1 0-.6 4M20 5v6h-6"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Suporte (fone de atendimento) — CTA "Falar com o suporte". */
export function IconHeadset(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M4 13v-1a8 8 0 0 1 16 0v1M4 13a2 2 0 0 0-2 2v1a2 2 0 0 0 2 2h1v-5H4zM20 13a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-1v-5h1zM19 18v.5a3 3 0 0 1-3 3H13"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Cartao/carteira — icone de contexto do card de billing (1.D.4). */
export function IconWallet(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth={2} />
      <path d="M3 10h18" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}

/**
 * Cartao de credito — icone da MENSALIDADE (o que o dono PAGA pra gente). Distinto
 * da carteira (IconWallet, usada no FATURAMENTO = o que ele RECEBE dos clientes):
 * tarja magnetica no topo + tracinho do numero embaixo desambiguam os dois na nav
 * e na Home (SCRUM-100 item-3).
 */
export function IconCreditCard(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" stroke="currentColor" strokeWidth={2} />
      <path d="M2.5 9.5h19" stroke="currentColor" strokeWidth={2} />
      <path d="M6 15h4" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

/**
 * Instagram — link social no footer da landing (W12). Tracado (herda
 * currentColor, padrao base()): quadrado arredondado + lente + ponto da camera.
 * Decorativo (aria-hidden via base) — o rotulo vive no link-pai.
 */
export function IconInstagram(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" stroke="currentColor" strokeWidth={2} />
      <circle cx="12" cy="12" r="3.8" stroke="currentColor" strokeWidth={2} />
      <circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" />
    </svg>
  );
}

/** Brilho/estrela — vertical "Estética" na faixa multi-vertical da landing (W7). */
export function IconSparkle(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M12 3c.4 3.6 1.4 4.6 5 5-3.6.4-4.6 1.4-5 5-.4-3.6-1.4-4.6-5-5 3.6-.4 4.6-1.4 5-5zM18.5 14c.2 1.8.7 2.3 2.5 2.5-1.8.2-2.3.7-2.5 2.5-.2-1.8-.7-2.3-2.5-2.5 1.8-.2 2.3-.7 2.5-2.5z"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Pincel/esmalte — vertical "Manicure / Nail" na faixa multi-vertical (W7). */
export function IconBrush(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M14.5 3.5 20.5 9.5 11 19a3 3 0 0 1-2 .9H6l-.9.9-2-2 .9-.9V15a3 3 0 0 1 .9-2L14.5 3.5z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path d="m12.5 5.5 6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

/** Check duplo decorativo — "entregue/lido" na bolha enviada da demo (W6). */
export function IconCheckDouble(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M1.5 12.5 6 17l1-1.2M11 7.5 14 17l9-10M7 12.5 11.5 17"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Enviar (avião de papel) — botao de envio do composer da demo (W6). */
export function IconSend(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M4 12 20 4l-6 16-3.2-6.4L4 12z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Brandmark Startap — simbolo Constelacao-S (Opcao A, solto). 5 nos em
 * ziguezague que o olho le como "S"; o no superior em ambar e o ponto focal.
 * Cores fixas (roxo #9A7CF0 -> #6431D6 descendo, ambar #E0A23C): a marca tem
 * paleta propria e NAO herda `color`. O `id` randomico evita colisao de
 * <defs> quando o simbolo aparece >1x na mesma pagina (login + sidebar/topbar).
 * Pensado p/ fundo escuro (app e sempre escuro). Fonte: mark-constelacao.svg.
 * Min. recomendado 24px; abaixo disso usar `BrandmarkMini`.
 */
export function Brandmark({ size = 32 }: { size?: number; color?: string }) {
  const uid = useId();
  const line = `csLine-${uid}`;
  const glow = `csGlow-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id={line} x1="44" y1="17" x2="20" y2="47" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#B59CF7" />
          <stop offset="1" stopColor="#6431D6" />
        </linearGradient>
        <radialGradient id={glow} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#E0A23C" stopOpacity="0.42" />
          <stop offset="0.55" stopColor="#E0A23C" stopOpacity="0.14" />
          <stop offset="1" stopColor="#E0A23C" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path
        d="M44 17 L20 24 L44 40 L20 47"
        fill="none"
        stroke={`url(#${line})`}
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.9}
      />
      <circle cx="20" cy="24" r="4.7" fill="#9A7CF0" />
      <circle cx="44" cy="40" r="4.7" fill="#7E5CE8" />
      <circle cx="20" cy="47" r="4.7" fill="#6431D6" />
      <circle cx="44" cy="17" r="13" fill={`url(#${glow})`} />
      <circle cx="44" cy="17" r="5.6" fill="#E0A23C" />
      <circle cx="44" cy="17" r="2.1" fill="#F6D9A3" />
    </svg>
  );
}

/**
 * Variante simplificada (3 nos, cores chapadas, sem gradiente/glow) p/ uso em
 * tamanhos pequenos onde o simbolo completo vira mancha. Fonte:
 * mark-constelacao-favicon.svg.
 */
export function BrandmarkMini({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path
        d="M23 9 L10 14 L22 23"
        fill="none"
        stroke="#9A7CF0"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="14" r="5" fill="#9A7CF0" />
      <circle cx="22" cy="23" r="5" fill="#6431D6" />
      <circle cx="23" cy="9" r="5.4" fill="#E0A23C" />
    </svg>
  );
}

/**
 * Brandmark monocromatico — 1 cor chapada via `currentColor`. No de destaque
 * vira anel (preserva o "ponto especial" sem depender de cor). Para casos
 * 1-cor (impressao, herdar tinta do contexto). Fonte: mono-constelacao.svg.
 */
export function BrandmarkMono({ size = 32, color }: { size?: number; color?: string }) {
  const c = color ?? 'currentColor';
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <path
        d="M44 17 L20 24 L44 40 L20 47"
        fill="none"
        stroke={c}
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="24" r="4.6" fill={c} />
      <circle cx="44" cy="40" r="4.6" fill={c} />
      <circle cx="20" cy="47" r="4.6" fill={c} />
      <circle cx="44" cy="17" r="6" fill="none" stroke={c} strokeWidth={2.6} />
      <circle cx="44" cy="17" r="1.6" fill={c} />
    </svg>
  );
}
