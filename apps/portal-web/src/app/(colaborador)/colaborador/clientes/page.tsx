'use client';

import { ClientesSection } from '@/components/clientes/clientes-section';
import { useColaborador } from '@/components/colaborador/colaborador-session-context';

export default function ColaboradorClientesPage() {
  const { slot, colaboradorId, timezone, crmClientesEnabled } = useColaborador();

  return (
    <ClientesSection
      mode="colaborador"
      slot={slot}
      colaboradorId={colaboradorId}
      timezone={timezone ?? 'America/Sao_Paulo'}
      crmEnabled={crmClientesEnabled}
    />
  );
}
