'use client';

/**
 * Faturamento + comissão do colaborador (read-only — SCRUM-32). O client cuida dos
 * estados remotos (loading/erro/vazio) por balde; aqui só o cabeçalho + o componente.
 */
import { ColaboradorComissaoClient } from '@/components/colaborador/colaborador-comissao-client';
import { PageHead } from '@/components/ui/page-head';

export default function ColaboradorComissaoPage() {
  return (
    <>
      <PageHead
        title="Meu faturamento"
        subtitle="O que você faturou e a sua comissão. Alterne entre o previsto e o já realizado."
      />
      <ColaboradorComissaoClient />
    </>
  );
}
