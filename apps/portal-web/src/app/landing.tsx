import { ParticleField } from '@/components/fx/particle-field';
import {
  Brandmark,
  IconBrush,
  IconCalendar,
  IconHeadset,
  IconHome,
  IconInstagram,
  IconPause,
  IconScissors,
  IconSparkle,
  IconWhatsapp,
} from '@/components/icons';
import { DemoCelular } from '@/components/landing/demo-celular';
import { HelpFab } from '@/components/landing/help-fab';
import { INSTAGRAM_HANDLE, INSTAGRAM_URL, SUPORTE_WHATSAPP_URL } from '@/lib/suporte';
import Link from 'next/link';

/**
 * Landing page pública da raiz (decisão Bruno): deslogado vê apresentação do
 * produto; o login vira botão "Entrar" no topo. Renderizada pelo page.tsx da
 * raiz quando NÃO há sessão (logado segue indo pra /inicio).
 *
 * Server component (zero fetch, zero estado) — só o ParticleField é client.
 * Visual herda o login v2: mesma constelação (variant login, fixed z-0),
 * mesma vinheta (.login-vignette, z-[1]) e conteúdo em z-[2]. Tema único
 * escuro; nenhum fundo próprio cobre o canvas (lição dos PRs #237-240).
 *
 * CTA primário aponta pro /cadastro (signup self-service, Missão 020 F1) — a
 * própria /cadastro trata a flag PORTAL_SIGNUP OFF com card "indisponível",
 * então o link pode existir mesmo com a flag desligada. O WhatsApp segue como
 * canal secundário (CTA final), reusando SUPORTE_WHATSAPP_URL (número público
 * centralizado em lib/suporte.ts) — sem env nova, sem número espalhado.
 */

const CONTATO_WHATSAPP_URL = `${SUPORTE_WHATSAPP_URL}?text=${encodeURIComponent(
  'Olá! Vi o site da Startap e quero testar o robô de atendimento grátis.',
)}`;

// Verticais cobertas (W7) — chips "Funciona pro seu negócio". O catch-all
// "Outros serviços" garante o "cobrimos todos". Ícones traçados (sem emoji cru),
// herdam o tema. Manicure/Estética usam ícones novos (IconBrush/IconSparkle).
const VERTICAIS = [
  { icon: IconScissors, label: 'Barbearia' },
  { icon: IconScissors, label: 'Salão & cabelo' },
  { icon: IconBrush, label: 'Manicure' },
  { icon: IconSparkle, label: 'Estética' },
  { icon: IconCalendar, label: 'Outros serviços' },
] as const;

// Bloco "Serve pro meu negócio?" (W7.3) — exemplos ILUSTRATIVOS por vertical
// (copy do growth). Nada aqui é conversa real de cliente (rótulo no rodapé).
const EXEMPLOS = [
  {
    vertical: 'Barbearia',
    texto:
      '"Quero cortar o cabelo sábado de manhã" → o robô mostra os horários livres, marca o corte e já cai na sua agenda.',
  },
  {
    vertical: 'Cabeleireiro & Salão',
    texto:
      '"Dá pra fazer escova e luzes na sexta?" → o robô confere o tempo de cada serviço, oferece o horário e confirma.',
  },
  {
    vertical: 'Manicure & Nail',
    texto:
      '"Tem horário pra alongamento amanhã à tarde?" → o robô responde na hora, agenda e avisa você.',
  },
  {
    vertical: 'Estética',
    texto:
      '"Queria marcar design de sobrancelha essa semana" → o robô mostra os dias, encaixa e confirma sozinho.',
  },
  {
    vertical: 'Outros serviços',
    texto:
      'Atende com hora marcada? O robô se adapta aos seus serviços e à sua agenda — é só dizer o que você faz.',
  },
] as const;

const PASSOS = [
  {
    titulo: 'A gente conecta o robô no seu WhatsApp',
    texto: 'Sem trocar de número e sem instalar nada. Você só escaneia um código e pronto.',
  },
  {
    titulo: 'Você cadastra seus serviços e horários',
    texto:
      'Diz o que você faz (corte, escova, manicure, sobrancelha…) e quando atende, num painel simples.',
  },
  {
    titulo: 'O robô atende, agenda e te avisa',
    texto: 'Cada horário marcado cai direto na sua agenda. Você só confere e trabalha.',
  },
] as const;

const RECURSOS = [
  {
    icon: IconWhatsapp,
    titulo: 'Atende 24 horas',
    texto:
      'Responde seus clientes no WhatsApp a qualquer hora, todo dia — até quando você está com a mão ocupada no cliente.',
  },
  {
    icon: IconCalendar,
    titulo: 'Agenda sozinho',
    texto:
      'Marca o horário direto na sua agenda (Google Calendar), sem encaixe errado e sem horário duplicado.',
  },
  {
    icon: IconHeadset,
    titulo: 'Entende áudio',
    texto:
      'Cliente mandou áudio? O robô escuta, entende e responde do mesmo jeito que faria com texto.',
  },
  {
    icon: IconPause,
    titulo: 'Você no controle',
    texto: 'Pause o robô quando quiser assumir a conversa — e libere de novo quando terminar.',
  },
  {
    icon: IconHome,
    titulo: 'Painel simples',
    texto:
      'Acompanhe agendamentos, serviços e horários num painel feito pra quem não tem tempo a perder.',
  },
] as const;

// Foco visível padrão do portal (anel roxo com offset no fundo da app).
const FOCUS_RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg';

export function Landing() {
  return (
    <div className="relative min-h-dvh overflow-x-clip bg-bg text-ink">
      {/* Fundo vivo idêntico ao login: constelação fixed z-0 + vinheta z-[1]
          pra contraste AA; todo o conteúdo abaixo fica em z-[2]. */}
      <ParticleField />
      <div className="login-vignette pointer-events-none fixed inset-0 z-[1]" aria-hidden />

      <div className="relative z-[2]">
        <Header />

        <main className="mx-auto w-full max-w-[1040px] px-5">
          <Hero />
          <DemoCelular />
          <Verticais />
          <ComoFunciona />
          <ServePraMim />
          <Recursos />
          <CtaFinal />
        </main>

        <Footer />
      </div>

      {/* FAB "Ajuda" (W12): fixo, fora do fluxo, por último no DOM (ordem de tab). */}
      <HelpFab />
    </div>
  );
}

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-[10px] font-display text-[19px] font-bold tracking-[-0.01em] text-ink md:text-[21px]">
      <Brandmark size={34} />
      <span>
        Start<span className="text-brand">ap</span>
      </span>
    </span>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-line-soft bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-[64px] w-full max-w-[1040px] items-center justify-between gap-3 px-5">
        {/* Logo clicável: volta pra home (raiz pública / landing). */}
        <Link
          href="/"
          aria-label="Startap — ir para o início"
          className={`inline-flex items-center rounded-[6px] ${FOCUS_RING}`}
        >
          <Wordmark />
        </Link>

        {/* Ações do topo: Criar conta (CTA primário) + Entrar (secundário/outline).
            O vendedor cria a conta na hora com o cliente, então o primário leva
            pro mesmo destino do "Quero testar grátis" (/cadastro). */}
        <nav aria-label="Acesso" className="flex items-center gap-2 sm:gap-2.5">
          <Link
            href="/login"
            className={`inline-flex h-10 items-center justify-center rounded-btn border border-line-strong bg-surface px-4 font-display text-[14px] font-semibold text-ink transition-colors duration-[120ms] hover:border-brand/60 hover:bg-surface-hover sm:px-5 ${FOCUS_RING}`}
          >
            Entrar
          </Link>
          <Link
            href="/cadastro"
            className={`inline-flex h-10 items-center justify-center rounded-btn bg-brand px-4 font-display text-[14px] font-semibold text-bg transition-[transform,background-color] duration-[120ms] hover:bg-brand-600 active:scale-[0.985] active:bg-brand-700 sm:px-5 ${FOCUS_RING}`}
          >
            Criar conta
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="flex flex-col items-center pb-16 pt-14 text-center md:pb-20 md:pt-20">
      <span className="mb-5 inline-flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint before:inline-block before:h-px before:w-[26px] before:bg-brand after:inline-block after:h-px after:w-[26px] after:bg-brand">
        Atendimento no automático
      </span>

      <h1 className="max-w-[18ch] font-display text-[clamp(32px,6vw,56px)] font-bold leading-[1.08] tracking-[-0.025em] text-ink">
        Seu WhatsApp atendendo e agendando <span className="text-brand">sozinho.</span>
      </h1>

      <p className="mt-5 max-w-[52ch] text-[clamp(15px,1.6vw,18px)] leading-[1.65] text-ink-soft">
        O robô da Startap responde seus clientes, marca horários direto na sua agenda e nunca tira
        folga. <span className="text-ink">Barbearia, salão, manicure, estética</span> — se você
        atende com hora marcada, é pra você.
      </p>

      <div className="mt-8 flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row">
        <Link
          href="/cadastro"
          className={`login-btn-glow inline-flex h-[52px] w-full items-center justify-center gap-2.5 rounded-btn bg-brand px-7 font-display text-[15px] font-semibold text-bg transition-[transform,background-color] duration-[120ms] hover:bg-brand-600 active:scale-[0.985] active:bg-brand-700 sm:w-auto ${FOCUS_RING}`}
        >
          Quero testar grátis
        </Link>
        <a
          href="#como-funciona"
          className={`inline-flex h-[52px] w-full items-center justify-center rounded-btn border border-line-strong bg-surface px-7 font-display text-[15px] font-semibold text-brand transition-colors duration-[120ms] hover:bg-surface-hover sm:w-auto ${FOCUS_RING}`}
        >
          Ver como funciona
        </a>
      </div>

      {/* Destaque da promoção (brief PM): 7 dias grátis, sem cartão. */}
      <p className="mt-8 inline-flex max-w-[46ch] items-center justify-center rounded-pill border border-amber/30 bg-amber-soft px-5 py-2.5 text-[13.5px] leading-normal text-amber">
        <strong className="mr-1 font-semibold">7 dias grátis</strong> pra testar com clientes de
        verdade — sem cartão, sem compromisso.
      </p>
    </section>
  );
}

function Verticais() {
  return (
    <section aria-labelledby="verticais-titulo" className="py-10 md:py-12">
      <h2
        id="verticais-titulo"
        className="text-center font-display text-[clamp(20px,2.6vw,26px)] font-bold tracking-[-0.02em] text-ink"
      >
        Funciona pro seu negócio
      </h2>
      <ul className="mx-auto mt-7 grid max-w-[760px] grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        {VERTICAIS.map(({ icon: Icon, label }) => (
          <li
            key={label}
            className="flex flex-col items-center gap-2.5 rounded-card border border-line bg-surface px-3 py-4 text-center transition-colors duration-[120ms] hover:border-brand/40"
          >
            <span className="inline-flex size-10 items-center justify-center rounded-[12px] bg-brand-soft text-brand">
              <Icon size={20} />
            </span>
            <span className="font-display text-[13.5px] font-semibold leading-tight text-ink">
              {label}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ComoFunciona() {
  return (
    <section
      id="como-funciona"
      aria-labelledby="como-funciona-titulo"
      className="scroll-mt-24 py-12 md:py-16"
    >
      <h2
        id="como-funciona-titulo"
        className="text-center font-display text-[clamp(24px,3.4vw,34px)] font-bold tracking-[-0.02em] text-ink"
      >
        Como funciona
      </h2>
      <p className="mx-auto mt-3 max-w-[44ch] text-center text-[15px] leading-[1.6] text-ink-soft">
        Três passos e o seu atendimento entra no piloto automático.
      </p>

      <ol className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
        {PASSOS.map((passo, i) => (
          <li key={passo.titulo} className="rounded-card border border-line bg-surface p-6">
            <span
              className="font-display text-[28px] font-bold leading-none text-brand"
              aria-hidden
            >
              {String(i + 1).padStart(2, '0')}
            </span>
            <h3 className="mt-4 font-display text-[17px] font-semibold leading-snug text-ink">
              {passo.titulo}
            </h3>
            <p className="mt-2 text-[14px] leading-[1.6] text-ink-soft">{passo.texto}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ServePraMim() {
  return (
    <section aria-labelledby="serve-titulo" className="py-12 md:py-16">
      <h2
        id="serve-titulo"
        className="text-center font-display text-[clamp(24px,3.4vw,34px)] font-bold tracking-[-0.02em] text-ink"
      >
        Serve pro meu negócio?
      </h2>
      <p className="mx-auto mt-3 max-w-[48ch] text-center text-[15px] leading-[1.6] text-ink-soft">
        Se o seu cliente marca horário pelo WhatsApp, serve. Veja como fica no seu caso:
      </p>

      <ul className="mt-9 grid grid-cols-1 gap-4 md:grid-cols-2">
        {EXEMPLOS.map(({ vertical, texto }) => (
          <li key={vertical} className="rounded-card border border-line bg-surface p-5">
            <h3 className="font-display text-[14px] font-semibold leading-snug text-brand">
              {vertical}
            </h3>
            <p className="mt-2 text-[14px] leading-[1.55] text-ink-soft">{texto}</p>
          </li>
        ))}
      </ul>

      <p className="mt-5 text-center text-[12px] italic text-ink-faint">
        Exemplos ilustrativos — não são conversas reais de clientes.
      </p>
    </section>
  );
}

function Recursos() {
  return (
    <section aria-labelledby="recursos-titulo" className="py-12 md:py-16">
      <h2
        id="recursos-titulo"
        className="text-center font-display text-[clamp(24px,3.4vw,34px)] font-bold tracking-[-0.02em] text-ink"
      >
        O que o robô faz por você
      </h2>
      <p className="mx-auto mt-3 max-w-[46ch] text-center text-[15px] leading-[1.6] text-ink-soft">
        Tudo que um bom atendente faria — só que sem fila, sem espera e sem folga.
      </p>

      <ul className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {RECURSOS.map(({ icon: Icon, titulo, texto }) => (
          <li
            key={titulo}
            className="rounded-card border border-line bg-surface p-6 transition-colors duration-[120ms] hover:border-brand/40"
          >
            <span className="inline-flex size-11 items-center justify-center rounded-[12px] bg-brand-soft text-brand">
              <Icon size={22} />
            </span>
            <h3 className="mt-4 font-display text-[16.5px] font-semibold leading-snug text-ink">
              {titulo}
            </h3>
            <p className="mt-2 text-[14px] leading-[1.6] text-ink-soft">{texto}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CtaFinal() {
  return (
    <section aria-labelledby="contato-titulo" className="py-14 md:py-20">
      <div className="login-card-glow relative mx-auto max-w-[640px] rounded-[22px] border border-line-strong bg-surface px-7 py-10 text-center sm:px-10">
        <h2
          id="contato-titulo"
          className="font-display text-[clamp(22px,3vw,30px)] font-bold tracking-[-0.02em] text-ink"
        >
          Comece seu teste grátis
        </h2>
        <p className="mx-auto mt-3 max-w-[40ch] text-[15px] leading-[1.65] text-ink-soft">
          Crie sua conta em um minuto e teste{' '}
          <strong className="font-semibold text-ink">7 dias grátis</strong> — sem cartão, sem
          compromisso. Prefere conversar antes? Chama a gente no WhatsApp.
        </p>
        <div className="mt-7 flex w-full flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/cadastro"
            className={`login-btn-glow inline-flex h-[52px] w-full items-center justify-center gap-2.5 rounded-btn bg-brand px-7 font-display text-[15px] font-semibold text-bg transition-[transform,background-color] duration-[120ms] hover:bg-brand-600 active:scale-[0.985] active:bg-brand-700 sm:w-auto ${FOCUS_RING}`}
          >
            Criar minha conta grátis
          </Link>
          <a
            href={CONTATO_WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex h-[52px] w-full items-center justify-center gap-2.5 rounded-btn border border-line-strong bg-transparent px-7 font-display text-[15px] font-semibold text-brand transition-colors duration-[120ms] hover:bg-surface-hover sm:w-auto ${FOCUS_RING}`}
          >
            <IconWhatsapp size={20} />
            Chamar no WhatsApp
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mt-4 border-t border-line-soft pb-24 sm:pb-8">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-7 px-5 py-9">
        {/* Linha de canais sociais (W12): WhatsApp + Instagram, texto + ícone. */}
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="inline-flex items-center gap-2.5 font-display text-[15px] font-semibold text-ink">
            <Brandmark size={26} />
            Startap — atendimento automático no WhatsApp
          </span>
          <div className="flex flex-col items-center gap-3 sm:flex-row">
            <a
              href={CONTATO_WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex h-11 items-center gap-2 rounded-pill border border-line-strong bg-surface px-5 text-[13.5px] font-semibold text-ink transition-colors duration-[120ms] hover:border-brand/50 hover:bg-surface-hover ${FOCUS_RING}`}
            >
              <IconWhatsapp size={18} />
              Falar no WhatsApp
            </a>
            <a
              href={INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Siga a Startap no Instagram, perfil arroba ${INSTAGRAM_HANDLE}`}
              className={`inline-flex h-11 items-center gap-2 rounded-pill border border-line-strong bg-surface px-5 text-[13.5px] font-semibold text-ink transition-colors duration-[120ms] hover:border-brand/50 hover:bg-surface-hover ${FOCUS_RING}`}
            >
              <IconInstagram size={18} />@{INSTAGRAM_HANDLE} no Instagram
            </a>
          </div>
        </div>

        {/* Linha de copyright + acesso. */}
        <div className="flex flex-col items-center justify-between gap-3 border-t border-line-soft pt-6 text-[13px] text-ink-faint sm:flex-row">
          <p>© {new Date().getFullYear()} Startap</p>
          <Link
            href="/login"
            className={`font-semibold text-brand hover:underline ${FOCUS_RING} rounded-[4px]`}
          >
            Entrar
          </Link>
        </div>
      </div>
    </footer>
  );
}
