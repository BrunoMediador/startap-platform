'use client';

import { ClientesWorkspace } from '@/components/clientes/clientes-workspace';
import { useTenant } from '@/components/shell/session-context';
import { useTenantTz } from '@/components/shell/tenant-tz-context';

export default function ClientesPage() {
  const { slot, crmClientesEnabled, whatsappManualEnabled } = useTenant();
  const timezone = useTenantTz();

  return (
    <ClientesWorkspace
      mode="owner"
      slot={slot}
      timezone={timezone}
      crmEnabled={crmClientesEnabled}
      whatsappManualEnabled={whatsappManualEnabled}
    />
  );
}
