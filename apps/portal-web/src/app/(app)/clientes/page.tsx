'use client';

import { ClientesSection } from '@/components/clientes/clientes-section';
import { useTenant } from '@/components/shell/session-context';
import { useTenantTz } from '@/components/shell/tenant-tz-context';

export default function ClientesPage() {
  const { slot, crmClientesEnabled } = useTenant();
  const timezone = useTenantTz();

  return (
    <ClientesSection
      mode="owner"
      slot={slot}
      timezone={timezone}
      crmEnabled={crmClientesEnabled}
    />
  );
}
