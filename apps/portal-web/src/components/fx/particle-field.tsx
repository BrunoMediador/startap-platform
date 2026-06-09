'use client';

/**
 * ParticleField — rede/constelacao do login v2 (spec 1.B.3) E hero do painel
 * (spec 1.D.1). Canvas 2D vanilla, sem libs. Pontos roxos #9A7CF0 (~1 em 9 ambar
 * #E0A23C) que driftam e se ligam por linhas quando proximos. Decorativo:
 * aria-hidden, nao tabavel, nao intercepta toque/clique.
 *
 * Dois modos (prop `variant`):
 *  - 'login' (default): full-screen `fixed inset:0`, densidade cheia, linha ao
 *    cursor no desktop. Dimensionado pelo viewport.
 *  - 'ambient' (painel hero, 1.D.1): confinado ao HOST (parent), ~3x menos denso,
 *    teto 22 desk/12 mob, drift/alpha menores, SEM linha ao cursor, suprimido no
 *    tema CLARO (rede roxa clara sobre lavanda nao compensa — 1.D.8). Dimensionado
 *    pelo getBoundingClientRect do host.
 *
 * Performance/A11y (P0, identicas nos dois modos):
 *  - pausa quando a aba sai de foco (Page Visibility);
 *  - DPR travado em 2; resize com debounce ~150ms;
 *  - prefers-reduced-motion: 1 frame estatico e NAO roda o loop; reage a mudanca
 *    da media query em runtime.
 */
import { useEffect, useRef } from 'react';

type Variant = 'login' | 'ambient';

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
  cursorLink: boolean; // linha reativa ao mouse (so login)
  confined: boolean; // dimensiona pelo host (ambient) ou viewport (login)
  lightOff: boolean; // suprime no tema claro (ambient)
}

const SHARED = {
  amberEvery: 9,
  cursorRadius: 160,
  cursorAlpha: 0.45,
  dprCap: 2,
  mobileBreakpoint: 880,
} as const;

const VARIANTS: Record<Variant, VariantCfg> = {
  login: {
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
    cursorLink: true,
    confined: false,
    lightOff: false,
  },
  // Hero do painel (1.D.1): tudo reduzido — fundo discreto, "respira".
  ambient: {
    density: 42000, // ~3x menos denso
    maxDesktop: 22,
    maxMobile: 12,
    minCount: 6,
    speed: 0.2, // drift mais lento
    radiusMin: 1.0,
    radiusMax: 2.0,
    linkDesktop: 120,
    linkMobile: 90,
    pointAlpha: 0.55, // mais translucido
    lineAlpha: 0.2, // rede mais fantasma
    cursorLink: false, // painel nao e vitrine
    confined: true, // dimensiona pelo host
    lightOff: true, // off no claro (1.D.8)
  },
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

    // No claro, o canvas ambient fica off (1.D.8). Reavalia no resize.
    function lightSuppressed(): boolean {
      if (!CFG.lightOff) return false;
      return document.documentElement.getAttribute('data-theme') === 'light';
    }

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
      if (CFG.confined) {
        // Dimensionado pelo host (faixa do topo) — nao desperdica pixels.
        const host = canvas?.parentElement;
        const rect = host?.getBoundingClientRect();
        W = rect?.width ?? 0;
        H = rect?.height ?? 0;
      } else {
        W = window.innerWidth;
        H = window.innerHeight;
      }
      if (!canvas || !ctx) return;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
      // No claro suprimido: limpa e nao desenha nada (so a aurora CSS fica).
      if (lightSuppressed()) {
        ctx.clearRect(0, 0, W, H);
        return;
      }
      if (reduced) step(); // 1 frame estatico
    }

    function step() {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      if (lightSuppressed()) return;
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
      if (reduced || lightSuppressed()) return; // estatico/off: nao anima
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
        // pode ter trocado pra/de claro -> reavalia o loop
        if (lightSuppressed() || reduced) stop();
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
    if (!reduced && !lightSuppressed()) start();
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

  // Login: full-screen fixed. Ambient: confinado ao host (.hero-fx via CSS).
  const className =
    variant === 'login' ? 'pointer-events-none fixed inset-0 z-0 block h-full w-full' : 'hero-fx';

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
