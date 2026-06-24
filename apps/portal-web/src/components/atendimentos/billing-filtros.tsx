'use client';

/**
 * Filtros do Billing (cliente / colaborador / serviço) — 100% CLIENT-SIDE: os
 * campos já chegam por linha, então a página filtra o array antes de renderizar a
 * lista, o gráfico e a comissão (recomputados a partir do filtrado). Dropdowns:
 *   - Colaborador via useEquipe (só estabelecimento; SOLO esconde).
 *   - Serviço via useServicos (catálogo do clone).
 *   - Cliente via input de texto (match case-insensitive sobre cliente_nome).
 *
 * Estado vive no page.tsx (controlado). Aqui só a UI + "Limpar".
 */
import { useTenant } from '@/components/shell/session-context';
import { Input } from '@/components/ui/input';
import { type BillingFiltro, FILTRO_VAZIO, temFiltroAtivo } from '@/lib/atendimentos-balde';
import { useEquipe, useServicos } from '@/lib/queries';
import { useId } from 'react';

export function BillingFiltros({
  value,
  onChange,
}: {
  value: BillingFiltro;
  onChange: (f: BillingFiltro) => void;
}) {
  const { slot, productType } = useTenant();
  const isEstabelecimento = productType === 'estabelecimento';
  const servicosQ = useServicos(slot);
  // Equipe só faz sentido (e só tem dados) no estabelecimento — não bate na API no SOLO.
  const equipeQ = useEquipe(isEstabelecimento ? slot : '');

  const clienteId = useId();
  const colabId = useId();
  const servicoId = useId();

  const colaboradores = (equipeQ.data?.colaboradores ?? []).filter((c) => c.ativo);
  const servicos = servicosQ.data ?? [];
  const ativo = temFiltroAtivo(value);

  return (
    <div className="rounded-card-sm border border-line bg-surface p-3.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="mx-0.5 font-display text-[13.5px] font-semibold text-ink">Filtros</h2>
        {ativo && (
          <button
            type="button"
            onClick={() => onChange(FILTRO_VAZIO)}
            className="font-display text-[12.5px] font-semibold text-brand underline-offset-2 outline-none hover:underline focus-visible:underline"
          >
            Limpar
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input
          id={clienteId}
          label="Cliente"
          placeholder="Buscar por nome"
          autoComplete="off"
          value={value.cliente}
          onChange={(e) => onChange({ ...value, cliente: e.target.value })}
        />

        {isEstabelecimento && (
          <SelectField
            id={colabId}
            label="Profissional"
            value={value.colaboradorId === null ? '' : String(value.colaboradorId)}
            onChange={(v) => onChange({ ...value, colaboradorId: v === '' ? null : Number(v) })}
            placeholder={equipeQ.isPending ? 'Carregando…' : 'Todos'}
          >
            {colaboradores.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.nome}
              </option>
            ))}
          </SelectField>
        )}

        <SelectField
          id={servicoId}
          label="Serviço"
          value={value.servico}
          onChange={(v) => onChange({ ...value, servico: v })}
          placeholder={servicosQ.isPending ? 'Carregando…' : 'Todos'}
        >
          {servicos.map((s) => (
            <option key={s.nome} value={s.nome}>
              {s.nome}
            </option>
          ))}
        </SelectField>
      </div>
    </div>
  );
}

/** <select> estilizado com a opção "Todos" (value="") no topo. */
function SelectField({
  id,
  label,
  value,
  onChange,
  placeholder,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex w-full flex-col gap-[7px]">
      <label htmlFor={id} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-[50px] w-full cursor-pointer appearance-none rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 text-[15px] text-ink outline-none transition-colors hover:border-[var(--c-input-hover-border)] focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus"
      >
        <option value="">{placeholder}</option>
        {children}
      </select>
    </div>
  );
}
