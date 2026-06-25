'use client';

/**
 * Seletor de período da tela Billing. Dois inputs date (`de`/`ate`) + presets
 * rápidos. PARAMETRIZÁVEL: presets e limites (min/max de cada input) vêm por prop —
 * a tela decide o que faz sentido pro contexto (Previsão olha o FUTURO, Faturado o
 * passado). Antes este componente assumia `max=hoje` hardcoded nos dois inputs, o
 * que travava o calendário na Previsão (datas futuras bloqueadas) — bug corrigido
 * movendo a regra de limites pra `lib/billing-periodo` e injetando aqui via prop.
 *
 * Controlado: o estado de/ate vive na página (vira a query key dos relatórios).
 */
import { Input } from '@/components/ui/input';
import type { Periodo, PeriodoLimites, PeriodoPreset } from '@/lib/billing-periodo';
import { cn } from '@/lib/cn';

export type { Periodo } from '@/lib/billing-periodo';

export function PeriodSelector({
  value,
  onChange,
  presets,
  limites,
}: {
  value: Periodo;
  onChange: (p: Periodo) => void;
  /** Presets rápidos a exibir (dependem do balde — futuro vs passado). */
  presets: PeriodoPreset[];
  /** Limites min/max de cada input (libera/trava datas futuras conforme o balde). */
  limites: PeriodoLimites;
}) {
  const ativo = (p: Periodo) => p.de === value.de && p.ate === value.ate;

  return (
    <div className="mb-4 space-y-3 rounded-card border border-line bg-surface p-3.5 shadow-card md:mb-5 md:p-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Períodos rápidos">
        {presets.map((o) => {
          const sel = ativo(o.value);
          return (
            <button
              key={o.label}
              type="button"
              aria-pressed={sel}
              onClick={() => onChange(o.value)}
              className={cn(
                'h-9 rounded-pill border px-3.5 font-display text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                sel
                  ? 'border-brand bg-brand text-bg'
                  : 'border-line bg-surface text-ink hover:bg-surface-hover',
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="De"
          type="date"
          value={value.de}
          min={limites.de.min}
          max={limites.de.max}
          onChange={(e) => onChange({ ...value, de: e.target.value })}
        />
        <Input
          label="Até"
          type="date"
          value={value.ate}
          min={limites.ate.min}
          max={limites.ate.max}
          onChange={(e) => onChange({ ...value, ate: e.target.value })}
        />
      </div>
    </div>
  );
}
