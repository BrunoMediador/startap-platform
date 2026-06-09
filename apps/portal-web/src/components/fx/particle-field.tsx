'use client';

/**
 * ParticleField — rede/constelacao do login v2 (spec 1.B.3) E fundo vivo do
 * painel. Canvas 2D vanilla, sem libs. Pontos roxos #9A7CF0 (~1 em 9 ambar
 * #E0A23C) que driftam e se ligam por linhas quando proximos. Decorativo:
 * aria-hidden, nao tabavel, nao intercepta toque/clique.
 *
 * Dois modos (prop `variant`) — MESMA vivacidade (decisao Bruno: o painel fica
 * "vivo igual ao login"), so muda o posicionamento na pilha:
 *  - 'login' (default): full-screen `fixed inset:0 z-0`, o conteudo do login
 *    fica em z-[2] por cima. Dimensionado pelo viewport.
 *  - 'appbg' (fundo do shell autenticado): mesma densidade/alpha/linha-ao-cursor
 *    do login, MAS posicionado ATRAS do conteudo em fluxo (`fixed inset:0
 *    z-[-1]`, ver `.app-bg` no CSS). Montado UMA vez no shell (app)/layout ->
 *    persiste entre navegacoes, sem remount/flash. Sidebar/topbar/bottom-nav e
 *    cards sao `bg-surface` solido e cobrem o canvas; as particulas aparecem nos
 *    vaos. Uma vinheta (`.app-vignette`) por cima garante contraste AA do texto.
 *
 * Tema unico escuro: nao ha mais supressao por tema claro.
 *
 * Performance/A11y (P0, identicas nos dois modos):
 *  - pausa quando a aba sai de foco (Page Visibility);
 *  - DPR travado em 2; resize com debounce ~150ms;
 *  - prefers-reduced-motion: 1 frame estatico e NAO roda o loop; reage a mudanca
 *    da media query em runtime.
 */
import { useEffect, useRef } from 'react';

type Variant = 'login' | 'appbg';

interface VariantCfg {
  density: number; // px² por particula
  maxDesktop: number;
  maxMobile: number;
  minCount: number;
  speed: number; // |vx|,|vy| max px/frame
  radiusMin: number;
  radiusMax: number;
  linkDesktop: number;
  linkMobile: number;
  pointAlpha: number;
  lineAlpha: number;
  cursorLink: boolean; // linha reativa ao mouse (desktop)
}

const SHARED = {
  amberEvery: 9,
  cursorRadius: 160,
  cursorAlpha: 0.45,
  dprCap: 2,
  mobileBreakpoint: 880,
} as const;

// Parametros de vivacidade nivel-login, compartilhados pelos dois modos
// (decisao Bruno: painel "vivo igual ao login"). So o posicionamento difere.
const VIVID: Omit<VariantCfg, 'cursorLink'> = {
  density: 14000,
  maxDesktop: 90,
  maxMobile: 45,
  minCount: 14,
  speed: 0.32,
  radiusMin: 1.1,
  radiusMax: 2.3,
  linkDesktop: 130,
  linkMobile: 100,
  pointAlpha: 0.85,
  lineAlpha: 0.34,
};

const VARIANTS: Record<Variant, VariantCfg> = {
  login: { ...VIVID, cursorLink: true },
  // Fundo do shell: identico ao login em densidade/alpha/linha-ao-cursor — so
  // muda o z-index (atras do conteudo em fluxo, ver `.app-bg`).
  appbg: { ...VIVID, cursorLink: true },
};

const PURPLE = '#9A7CF0';
const AMBER = '#E0A23C';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
}

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export function ParticleField({ variant = 'login' }: { variant?: Variant }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const CFG = VARIANTS[variant];
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = motionQuery.matches;

    let W = 0;
    let H = 0;
    let particles: Particle[] = [];
    const mouse: { x: number | null; y: number | null } = { x: null, y: null };
    let rafId: number | null = null;
    let running = false;

    const isMobile = () => window.innerWidth <= SHARED.mobileBreakpoint;

    function targetCount(): number {
      const area = W * H;
      const density = area / CFG.density;
      const cap = isMobile() ? CFG.maxMobile : CFG.maxDesktop;
      return Math.max(CFG.minCount, Math.min(cap, Math.round(density)));
    }

    function linkDist(): number {
      return isMobile() ? CFG.linkMobile : CFG.linkDesktop;
    }

    function makeParticle(): Particle {
      const amber = Math.random() < 1 / SHARED.amberEvery;
      const vx = rand(-CFG.speed, CFG.speed) || 0.08;
      const vy = rand(-CFG.speed, CFG.speed) || 0.08;
      return {
        x: Math.random() * W,
        y: Math.random() * H,
        vx: Math.max(-CFG.speed, Math.min(CFG.speed, vx)),
        vy: Math.max(-CFG.speed, Math.min(CFG.speed, vy)),
        r: rand(CFG.radiusMin, CFG.radiusMax),
        color: amber ? AMBER : PURPLE,
      };
    }

    function build() {
      const n = targetCount();
      particles = [];
      for (let i = 0; i < n; i++) particles.push(makeParticle());
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, SHARED.dprCap);
      // Ambos os modos dimensionam pelo viewport inteiro.
      W = window.innerWidth;
      H = window.innerHeight;
      if (!canvas || !ctx) return;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
      if (reduced) step(); // 1 frame estatico
    }

    function step() {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      const dist = linkDist();

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -10) p.x = W + 10;
        else if (p.x > W + 10) p.x = -10;
        if (p.y < -10) p.y = H + 10;
        else if (p.y > H + 10) p.y = -10;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = CFG.pointAlpha;
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      const mobile = isMobile();
      for (let a = 0; a < particles.length; a++) {
        const pa = particles[a];
        for (let b = a + 1; b < particles.length; b++) {
          const pb = particles[b];
          const dx = pa.x - pb.x;
          const dy = pa.y - pb.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < dist * dist) {
            const d = Math.sqrt(d2);
            const alpha = (1 - d / dist) * CFG.lineAlpha;
            ctx.strokeStyle = `rgba(154,124,240,${alpha.toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
            ctx.stroke();
          }
        }
        // linha ao cursor (so login, desktop) — "coisa viva" reage ao mouse
        if (CFG.cursorLink && mouse.x !== null && mouse.y !== null && !mobile) {
          const mdx = pa.x - mouse.x;
          const mdy = pa.y - mouse.y;
          const md2 = mdx * mdx + mdy * mdy;
          const mr = SHARED.cursorRadius;
          if (md2 < mr * mr) {
            const ma = (1 - Math.sqrt(md2) / mr) * SHARED.cursorAlpha;
            ctx.strokeStyle = `rgba(224,162,60,${ma.toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(mouse.x, mouse.y);
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    function loop() {
      if (!running) return;
      step();
      rafId = requestAnimationFrame(loop);
    }

    function start() {
      if (reduced) return; // reduced-motion: 1 frame estatico, nao anima
      if (running) return;
      running = true;
      loop();
    }

    function stop() {
      running = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    function onVisibility() {
      if (document.hidden) stop();
      else start();
    }

    function onMouseMove(e: MouseEvent) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    }
    function onMouseLeave() {
      mouse.x = null;
      mouse.y = null;
    }

    let resizeTimer: number | null = null;
    function onResize() {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resize();
        if (reduced) stop();
        else start();
      }, 150);
    }

    function onMotionChange(e: MediaQueryListEvent) {
      reduced = e.matches;
      if (reduced) {
        stop();
        resize();
      } else {
        resize();
        start();
      }
    }

    document.addEventListener('visibilitychange', onVisibility);
    if (CFG.cursorLink) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseleave', onMouseLeave);
    }
    window.addEventListener('resize', onResize);
    motionQuery.addEventListener('change', onMotionChange);

    resize();
    if (!reduced) start();
    else step();

    return () => {
      stop();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (CFG.cursorLink) {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseleave', onMouseLeave);
      }
      window.removeEventListener('resize', onResize);
      motionQuery.removeEventListener('change', onMotionChange);
    };
  }, [variant]);

  // Login: full-screen fixed em z-0 (o conteudo do login fica em z-[2]).
  // Appbg: full-screen fixed em z-[-1] -> ATRAS do conteudo em fluxo do shell
  //   (cards/sidebar opacos cobrem; particulas so aparecem nos vaos). `.app-bg`.
  const className =
    variant === 'appbg' ? 'app-bg' : 'pointer-events-none fixed inset-0 z-0 block h-full w-full';

  return (
    <canvas
      ref={canvasRef}
      // Decorativo (spec 1.B.8 / 1.D.1): aria-hidden + nao tabavel +
      // pointer-events:none (no className). Nao intercepta toque/clique.
      aria-hidden="true"
      tabIndex={-1}
      className={className}
    />
  );
}
