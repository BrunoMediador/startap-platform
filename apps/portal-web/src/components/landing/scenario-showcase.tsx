'use client';

import styles from '@/app/landing.module.css';
import { useRef, useState } from 'react';
import { LANDING_SCENARIOS, type LandingScenarioId, getLandingScenario } from './landing-content';

export function ScenarioShowcase() {
  const [activeId, setActiveId] = useState<LandingScenarioId>('agenda');
  const flowRef = useRef<HTMLDivElement>(null);
  const scenario = getLandingScenario(activeId);

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    flowRef.current?.style.setProperty('--landing-tilt-y', `${x * 7 - 2}deg`);
    flowRef.current?.style.setProperty('--landing-tilt-x', `${y * -5 + 1}deg`);
  };

  const resetTilt = () => {
    flowRef.current?.style.removeProperty('--landing-tilt-y');
    flowRef.current?.style.removeProperty('--landing-tilt-x');
  };

  return (
    <div
      className={styles.stage}
      aria-label="Demonstração interativa do atendimento no WhatsApp"
      onPointerMove={handlePointerMove}
      onPointerLeave={resetTilt}
    >
      <div className={styles.scenarios} aria-label="Escolha uma interação para demonstrar">
        {LANDING_SCENARIOS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={styles.scenarioButton}
            aria-pressed={item.id === activeId}
            onClick={() => setActiveId(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div ref={flowRef} className={styles.flow} key={scenario.id}>
        <section className={`${styles.flowCard} ${styles.phone}`} aria-label="Conversa ilustrativa">
          <div className={styles.phoneTop}>
            <span className={styles.avatar} aria-hidden="true">
              BV
            </span>
            <span>
              <strong className={styles.phoneName}>Barbearia do Vale</strong>
              <span className={styles.online}>● online</span>
            </span>
          </div>
          <div className={styles.chat} aria-live="polite" aria-atomic="true">
            {scenario.messages.map((message, index) => (
              <p
                // A posição é estável dentro de cada cenário e evita usar o texto como identidade.
                key={`${scenario.id}-${index}`}
                className={`${styles.bubble} ${
                  message.role === 'customer' ? styles.customerBubble : styles.assistantBubble
                } ${message.emphasis ? styles.emphasisBubble : ''}`}
              >
                {message.text}
              </p>
            ))}
          </div>
        </section>

        <section className={`${styles.flowCard} ${styles.calendar}`} aria-label={scenario.status}>
          <p className={styles.statusLabel}>{scenario.status}</p>
          <p className={styles.calendarDay}>{scenario.day}</p>
          <div className={styles.eventCard}>
            <strong>{scenario.eventTitle}</strong>
            <span>{scenario.eventDetail}</span>
          </div>
        </section>

        <section
          className={`${styles.flowCard} ${styles.control}`}
          aria-label="Controle do assistente"
        >
          <span>
            <strong>{scenario.controlTitle}</strong>
            <small>{scenario.controlDetail}</small>
          </span>
          <span
            className={`${styles.toggle} ${scenario.assistantPaused ? styles.togglePaused : ''}`}
            aria-hidden="true"
          />
        </section>
      </div>
    </div>
  );
}
