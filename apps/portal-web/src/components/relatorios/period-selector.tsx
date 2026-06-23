'use client';

/**
 * Seletor de período dos relatórios (app de gestão). Dois inputs date (`de`/`ate`)
 * + presets rápidos (Este mês / Mês passado / Hoje). O default é mês corrente (dia
 * 1 até hoje) — quem monta a página decide o estado inicial; aqui só renderiza e
 * emite mudanças. O `ate` nunca passa de hoje (max). `de` não passa de `ate`.
 *
 * Controlado: o estado de/ate vive na página (vira a query key dos relatórios).
 */
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { firstOfMonthISO, toISODate } from '@/lib/format';

export interface Periodo {
  de: string; // 'YYYY-MM-DD'
  ate: string; // 'YYYY-MM-DD'
}

/** Presets relativos a hoje (calculados no client, fuso local). */
function presets(now = new Date()): { label: string; value: Periodo }[] {
  const hoje = toISODate(now);
  const inicioMes = firstOfMonthISO(now);
  const primeiroMesPassado = toISODate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const ultimoMesPassado = toISODate(new Date(now.getFullYear(), now.getMonth(), 0));
  return [
    { label: 'Este mês', value: { de: inicioMes, ate: hoje } },
    { label: 'Mês passado', value: { de: primeiroMesPassado, ate: ultimoMesPassado } },
    { label: 'Hoje', value: { de: hoje, ate: hoje } },
  ];
}

export function PeriodSelector({
  value,
  onChange,
}: {
  value: Periodo;
  onChange: (p: Periodo) => void;
}) {
  const hoje = toISODate();
  const opcoes = presets();
  const ativo = (p: Periodo) => p.de === value.de && p.ate === value.ate;

  return (
    <div className="mb-5 space-y-3 rounded-card border border-line bg-surface p-4 shadow-card">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Períodos rápidos">
        {opcoes.map((o) => {
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
          max={value.ate || hoje}
          onChange={(e) => onChange({ ...value, de: e.target.value })}
        />
        <Input
          label="Até"
          type="date"
          value={value.ate}
          min={value.de}
          max={hoje}
          onChange={(e) => onChange({ ...value, ate: e.target.value })}
        />
      </div>
    </div>
  );
}
