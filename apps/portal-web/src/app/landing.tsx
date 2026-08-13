import { Brandmark, IconInstagram, IconWhatsapp } from '@/components/icons';
import { HelpFab } from '@/components/landing/help-fab';
import { LandingAmbient } from '@/components/landing/landing-ambient';
import { LANDING_CTAS } from '@/components/landing/landing-content';
import { ScenarioShowcase } from '@/components/landing/scenario-showcase';
import { INSTAGRAM_HANDLE, INSTAGRAM_URL, SUPORTE_WHATSAPP_URL } from '@/lib/suporte';
import Link from 'next/link';
import styles from './landing.module.css';

const CONTATO_WHATSAPP_URL = `${SUPORTE_WHATSAPP_URL}?text=${encodeURIComponent(
  'Olá! Vi o site da Startap e quero testar o assistente de atendimento grátis.',
)}`;

const JOURNEY = [
  {
    title: 'Cliente chama',
    text: 'O assistente responde em linguagem natural pelo WhatsApp.',
  },
  {
    title: 'Agenda é consultada',
    text: 'Serviços, duração e horários disponíveis entram na conversa.',
  },
  {
    title: 'Você segue no controle',
    text: 'O horário é confirmado e você pode pausar ou assumir a qualquer momento.',
  },
] as const;

export function Landing() {
  return (
    <div className={styles.page} data-landing-root>
      <LandingAmbient />

      <div className={styles.content}>
        <Header />

        <main>
          <div className={styles.shell}>
            <section className={styles.hero} aria-labelledby="landing-title">
              <div>
                <p className={styles.eyebrow}>
                  <span className={styles.liveDot} aria-hidden="true" />
                  Atendimento no automático
                </p>
                <h1 id="landing-title" className={styles.heroTitle}>
                  Atenda e marque horários{' '}
                  <span className={styles.gradientText}>enquanto você trabalha.</span>
                </h1>
                <p className={styles.lead}>
                  A Startap atende seus clientes, encontra o melhor horário e agenda pelo WhatsApp —
                  no seu número, com você no controle.
                </p>
                <div className={styles.heroActions}>
                  <Link
                    href={LANDING_CTAS.primary.href}
                    className={`${styles.button} ${styles.buttonPrimary}`}
                  >
                    {LANDING_CTAS.primary.label} →
                  </Link>
                </div>
                <p className={styles.trial}>
                  <span aria-hidden="true">✓</span>
                  <strong>Sem cartão</strong>
                  <span aria-hidden="true">•</span>
                  <span>Você pausa quando quiser</span>
                </p>
              </div>

              <ScenarioShowcase />
            </section>
          </div>

          <TrustStrip />
          <ProductJourney />
          <FinalCta />
        </main>

        <Footer />
      </div>

      <HelpFab />
    </div>
  );
}

function Header() {
  return (
    <header className={styles.shell}>
      <nav className={styles.nav} aria-label="Navegação principal">
        <Link href="/" className={styles.wordmark} aria-label="Startap — ir para o início">
          <span className={styles.logoMark} aria-hidden="true">
            <Brandmark size={36} />
          </span>
          <span className={styles.logoName}>Startap</span>
        </Link>

        <div className={styles.navActions}>
          <Link href={LANDING_CTAS.login.href} className={styles.button}>
            {LANDING_CTAS.login.label}
          </Link>
          <Link
            href={LANDING_CTAS.primary.href}
            className={`${styles.button} ${styles.buttonPrimary}`}
          >
            Testar 7 dias
          </Link>
        </div>
      </nav>
    </header>
  );
}

function TrustStrip() {
  return (
    <section className={styles.strip} aria-label="Benefícios do teste">
      <div className={`${styles.shell} ${styles.stripInner}`}>
        <span>
          <strong>7 dias</strong> grátis
        </span>
        <span>
          Funciona no <strong>seu número</strong>
        </span>
        <span>
          Integra com <strong>Google Agenda</strong>
        </span>
        <span>
          Entende <strong>áudios</strong>
        </span>
      </div>
    </section>
  );
}

function ProductJourney() {
  return (
    <section className={`${styles.shell} ${styles.section}`} aria-labelledby="journey-title">
      <div className={styles.sectionHead}>
        <h2 id="journey-title" className={styles.sectionTitle}>
          Do “oi” ao horário confirmado. Sem deixar cliente esperando.
        </h2>
        <p className={styles.sectionIntro}>
          O atendimento continua fluindo enquanto você cuida do que precisa da sua atenção.
        </p>
      </div>

      <ol className={styles.journey}>
        {JOURNEY.map((step, index) => (
          <li key={step.title} className={styles.step}>
            <span className={styles.stepNumber} aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
          </li>
        ))}
      </ol>

      <div className={styles.modes}>
        <article className={styles.mode}>
          <span className={styles.modeIcon} aria-hidden="true">
            ✦
          </span>
          <div>
            <h3>Com agenda</h3>
            <p>Atende, oferece horários e confirma o agendamento automaticamente.</p>
          </div>
        </article>
        <article className={styles.mode}>
          <span className={styles.modeIcon} aria-hidden="true">
            ↗
          </span>
          <div>
            <h3>Só atendimento</h3>
            <p>Responde dúvidas, qualifica o contato e encaminha para sua equipe.</p>
          </div>
        </article>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className={styles.final} aria-labelledby="final-title">
      <div className={styles.finalCopy}>
        <p className={styles.eyebrow}>
          <span className={styles.liveDot} aria-hidden="true" />
          Seu próximo atendimento pode ser automático
        </p>
        <h2 id="final-title" className={styles.finalTitle}>
          Teste com clientes de verdade por 7 dias.
        </h2>
        <p className={styles.finalText}>Sem cartão e sem trocar de número.</p>
        <p className={styles.fallback}>
          Prefere conversar antes?{' '}
          <a
            href={CONTATO_WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.footerLink}
          >
            Chame a Startap no WhatsApp
          </a>
          .
        </p>
      </div>
      <Link href={LANDING_CTAS.final.href} className={`${styles.button} ${styles.buttonPrimary}`}>
        {LANDING_CTAS.final.label} →
      </Link>
    </section>
  );
}

function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`${styles.shell} ${styles.footerInner}`}>
        <div className={styles.footerBrand}>
          <Brandmark size={28} />
          <span>Startap — atendimento automático no WhatsApp</span>
        </div>

        <div className={styles.socialLinks}>
          <a
            href={CONTATO_WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`${styles.socialLink} ${styles.footerLink}`}
          >
            <IconWhatsapp size={18} />
            Falar no WhatsApp
          </a>
          <a
            href={INSTAGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Siga a Startap no Instagram, perfil arroba ${INSTAGRAM_HANDLE}`}
            className={`${styles.socialLink} ${styles.footerLink}`}
          >
            <IconInstagram size={18} />@{INSTAGRAM_HANDLE} no Instagram
          </a>
        </div>

        <div className={styles.footerBottom}>
          <p>© {new Date().getFullYear()} Startap</p>
          <nav className={styles.legalLinks} aria-label="Links legais e acesso">
            <Link href={LANDING_CTAS.demo.href} className={styles.footerLink}>
              {LANDING_CTAS.demo.label}
            </Link>
            <Link href="/termos" className={styles.footerLink}>
              Termos de Uso
            </Link>
            <Link href="/privacidade" className={styles.footerLink}>
              Política de Privacidade
            </Link>
            <Link href={LANDING_CTAS.login.href} className={styles.footerLink}>
              {LANDING_CTAS.login.label}
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
