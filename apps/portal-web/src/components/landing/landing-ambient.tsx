'use client';

import styles from '@/app/landing.module.css';
import { useEffect, useRef } from 'react';

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  amber: boolean;
  pulse: number;
};

type TrailPoint = { x: number; y: number; life: number };

export function LandingAmbient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    const root = canvas?.closest<HTMLElement>('[data-landing-root]');
    if (!canvas || !context || !root) return;

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = { x: -999, y: -999, active: false };
    let particles: Particle[] = [];
    let trail: TrailPoint[] = [];
    let width = 1;
    let height = 1;
    let frame = 0;
    let destroyed = false;

    const drawComet = (time: number, offset: number, yBase: number) => {
      const x = ((time * 0.105 + offset) % (width + 520)) - 260;
      const y = yBase + Math.sin((time + offset) * 0.00045) * 70;
      const gradient = context.createLinearGradient(x - 150, y - 55, x, y);
      gradient.addColorStop(0, 'rgba(155, 115, 255, 0)');
      gradient.addColorStop(0.7, 'rgba(155, 115, 255, 0.18)');
      gradient.addColorStop(1, 'rgba(240, 184, 75, 0.9)');
      context.beginPath();
      context.moveTo(x - 150, y - 55);
      context.lineTo(x, y);
      context.strokeStyle = gradient;
      context.lineWidth = 2;
      context.stroke();
      context.beginPath();
      context.arc(x, y, 2.8, 0, Math.PI * 2);
      context.fillStyle = 'rgba(240, 184, 75, 0.95)';
      context.fill();
    };

    const draw = (time = 0) => {
      if (destroyed) return;
      context.clearRect(0, 0, width, height);

      drawComet(time, 0, 130);
      drawComet(time, width * 0.58, 430);

      if (pointer.active) {
        const glow = context.createRadialGradient(
          pointer.x,
          pointer.y,
          0,
          pointer.x,
          pointer.y,
          115,
        );
        glow.addColorStop(0, 'rgba(155, 115, 255, 0.18)');
        glow.addColorStop(0.45, 'rgba(155, 115, 255, 0.07)');
        glow.addColorStop(1, 'rgba(155, 115, 255, 0)');
        context.fillStyle = glow;
        context.beginPath();
        context.arc(pointer.x, pointer.y, 115, 0, Math.PI * 2);
        context.fill();
      }

      trail = trail.filter((point) => {
        point.life -= 0.035;
        return point.life > 0;
      });
      trail.forEach((point, index) => {
        context.beginPath();
        context.arc(point.x, point.y, 2 + index * 0.08, 0, Math.PI * 2);
        context.fillStyle = `rgba(240, 184, 75, ${point.life * 0.36})`;
        context.fill();
      });

      for (let index = 0; index < particles.length; index += 1) {
        const particle = particles[index];
        if (!motionQuery.matches) {
          if (pointer.active) {
            const forceX = pointer.x - particle.x;
            const forceY = pointer.y - particle.y;
            const distance = Math.hypot(forceX, forceY);
            if (distance < 220 && distance > 1) {
              particle.vx += (forceX / distance) * 0.006;
              particle.vy += (forceY / distance) * 0.006;
            }
          }
          const speed = Math.hypot(particle.vx, particle.vy);
          if (speed > 0.48) {
            particle.vx = (particle.vx / speed) * 0.48;
            particle.vy = (particle.vy / speed) * 0.48;
          }
          particle.x += particle.vx;
          particle.y += particle.vy;
          if (particle.x < 0 || particle.x > width) particle.vx *= -1;
          if (particle.y < 0 || particle.y > height) particle.vy *= -1;
        }

        for (let targetIndex = index + 1; targetIndex < particles.length; targetIndex += 1) {
          const target = particles[targetIndex];
          const distance = Math.hypot(particle.x - target.x, particle.y - target.y);
          if (distance < 150) {
            context.beginPath();
            context.moveTo(particle.x, particle.y);
            context.lineTo(target.x, target.y);
            context.strokeStyle = `rgba(155, 115, 255, ${(1 - distance / 150) * 0.38})`;
            context.lineWidth = 0.9;
            context.stroke();
          }
        }

        if (pointer.active) {
          const distance = Math.hypot(particle.x - pointer.x, particle.y - pointer.y);
          if (distance < 210) {
            context.beginPath();
            context.moveTo(particle.x, particle.y);
            context.lineTo(pointer.x, pointer.y);
            context.strokeStyle = `rgba(240, 184, 75, ${(1 - distance / 210) * 0.68})`;
            context.lineWidth = 1.35;
            context.stroke();
          }
        }

        const pulse = motionQuery.matches ? 1 : 1 + Math.sin(time * 0.002 + particle.pulse) * 0.28;
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius * pulse, 0, Math.PI * 2);
        context.fillStyle = particle.amber
          ? 'rgba(240, 184, 75, 0.98)'
          : 'rgba(164, 129, 255, 0.94)';
        context.fill();
      }

      if (!motionQuery.matches && !document.hidden) frame = window.requestAnimationFrame(draw);
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      const ratio = Math.min(window.devicePixelRatio || 1, 1.35);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = width < 520 ? 46 : 84;
      particles = Array.from({ length: count }, (_, index) => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.38,
        vy: (Math.random() - 0.5) * 0.38,
        radius: index % 10 === 0 ? 3.2 : 1.65,
        amber: index % 12 === 0,
        pulse: Math.random() * Math.PI * 2,
      }));
      window.cancelAnimationFrame(frame);
      draw(performance.now());
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (motionQuery.matches) return;
      const canvasRect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - canvasRect.left;
      pointer.y = event.clientY - canvasRect.top;
      pointer.active = pointer.y >= 0 && pointer.y <= height;
      if (pointer.active) trail.push({ x: pointer.x, y: pointer.y, life: 1 });
      if (trail.length > 22) trail.shift();

      const rootRect = root.getBoundingClientRect();
      const relativeX = (event.clientX - rootRect.left) / rootRect.width;
      const relativeY = (event.clientY - rootRect.top) / rootRect.height;
      root.style.setProperty('--landing-spot-x', `${relativeX * 100}%`);
      root.style.setProperty('--landing-spot-y', `${relativeY * 100}%`);
    };

    const handlePointerLeave = () => {
      pointer.active = false;
    };

    const handleVisibility = () => {
      window.cancelAnimationFrame(frame);
      if (!document.hidden) draw(performance.now());
    };

    const handleMotionChange = () => {
      window.cancelAnimationFrame(frame);
      trail = [];
      draw(performance.now());
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    root.addEventListener('pointermove', handlePointerMove, { passive: true });
    root.addEventListener('pointerleave', handlePointerLeave);
    document.addEventListener('visibilitychange', handleVisibility);
    motionQuery.addEventListener('change', handleMotionChange);

    return () => {
      destroyed = true;
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      root.removeEventListener('pointermove', handlePointerMove);
      root.removeEventListener('pointerleave', handlePointerLeave);
      document.removeEventListener('visibilitychange', handleVisibility);
      motionQuery.removeEventListener('change', handleMotionChange);
    };
  }, []);

  return (
    <div className={styles.ambient} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.particles} />
      <span className={`${styles.orb} ${styles.orbPrimary}`} />
      <span className={`${styles.orb} ${styles.orbSecondary}`} />
    </div>
  );
}
