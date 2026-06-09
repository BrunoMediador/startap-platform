'use client';

/**
 * ParticleField — rede/constelacao do login v2 (spec 1.B.3). Canvas 2D vanilla,
 * sem libs. Pontos roxos #9A7CF0 (~1 em 9 ambar #E0A23C) que driftam e se ligam
 * por linhas quando proximos. Decorativo: aria-hidden, nao tabavel, nao
 * intercepta toque/clique do form (pointer-events:none via CSS no pai).
 *
 * Performance/A11y (P0, spec 1.B.3):
 *  - pausa quando a aba sai de foco (Page Visibility);
 *  - DPR travado em 2; resize com debounce ~150ms;
 *  - prefers-reduced-motion: desenha 1 frame estatico e NAO roda o loop; reage a
 *    mudanca da media query em runtime;
 *  - teto 90 desktop / 45 mobile(<880px) / 0 reduced-motion, piso 14.
 */
import { useEffect, useRef } from 'react';

const CFG = {
  density: 14000, // px² por particula
  maxDesktop: 90,
  maxMobile: 45,
  minCount: 14,
  speed: 0.32, // |vx|,|vy| max px/frame
  radiusMin: 1.1,
  radiusMax: 2.3,
  linkDesktop: 130,
  linkMobile: 100,
  amberEvery: 9, // 1 em 9 pontos e ambar
  lineAlpha: 0.34,
  cursorRadius: 160,
  cursorAlpha: 0.45,
  dprCap: 2,
  mobileBreakpoint: 880,
} as const;

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

export function ParticleField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = motionQuery.matches;

    let W = 0;
    let H = 0;
    let particles: Particle[] = [];
    const mouse: { x: number | null; y: number | null } = { x: null, y: null };
    let rafId: number | null = null;
    let running = false;

    const isMobile = () => window.innerWidth <= CFG.mobileBreakpoint;

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
      const amber = Math.random() < 1 / CFG.amberEvery;
      // velocidade lenta com clamp em ±speed; fallback 0.12 pra nao ficar parado
      const vx = rand(-CFG.speed, CFG.speed) || 0.12;
      const vy = rand(-CFG.speed, CFG.speed) || 0.12;
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
      const dpr = Math.min(window.devicePixelRatio || 1, CFG.dprCap);
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

      // mover + desenhar pontos (wrap nas bordas — reaparece do outro lado)
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
        ctx.globalAlpha = 0.85;
        ctx.fill();
      }

      // linhas entre pares proximos + linha ao cursor (desktop)
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
        // linha ao cursor (desktop only) — "coisa viva" reage ao mouse
        if (mouse.x !== null && mouse.y !== null && !mobile) {
          const mdx = pa.x - mouse.x;
          const mdy = pa.y - mouse.y;
          const md2 = mdx * mdx + mdy * mdy;
          const mr = CFG.cursorRadius;
          if (md2 < mr * mr) {
            const ma = (1 - Math.sqrt(md2) / mr) * CFG.cursorAlpha;
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
      if (reduced) return; // estatico: nao anima
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

    // pausa quando a aba sai de foco (spec 1.B.3 P0)
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
      resizeTimer = window.setTimeout(resize, 150);
    }

    function onMotionChange(e: MediaQueryListEvent) {
      reduced = e.matches;
      if (reduced) {
        stop();
        resize(); // redesenha 1 frame estatico
      } else {
        resize();
        start();
      }
    }

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);
    window.addEventListener('resize', onResize);
    motionQuery.addEventListener('change', onMotionChange);

    resize();
    if (!reduced) start();

    return () => {
      stop();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onMouseLeave);
      window.removeEventListener('resize', onResize);
      motionQuery.removeEventListener('change', onMotionChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      // Decorativo (spec 1.B.8): aria-hidden + nao tabavel (tabIndex -1) +
      // pointer-events:none. Nao intercepta toque/clique do form.
      aria-hidden="true"
      tabIndex={-1}
      className="pointer-events-none fixed inset-0 z-0 block h-full w-full"
    />
  );
}
