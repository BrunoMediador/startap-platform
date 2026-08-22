'use client';

import { ClientesWorkspace } from '@/components/clientes/clientes-workspace';
import { useColaborador } from '@/components/colaborador/colaborador-session-context';

export default function ColaboradorClientesPage() {
  const { slot, colaboradorId, timezone, crmClientesEnabled } = useColaborador();

  return (
    <ClientesWorkspace
      mode="colaborador"
      slot={slot}
      colaboradorId={colaboradorId}
      timezone={timezone ?? 'America/Sao_Paulo'}
      crmEnabled={crmClientesEnabled}
    />
  );
}
