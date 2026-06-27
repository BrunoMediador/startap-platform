import { LegalDoc } from '@/components/legal/legal-doc';
import { POLITICA_PRIVACIDADE } from '@/lib/legal';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Política de Privacidade · Startap',
  description: 'Política de Privacidade da plataforma Startap (LGPD).',
};

/**
 * Rota PÚBLICA /privacidade (SCRUM-1). Renderiza a Política de Privacidade a partir do
 * módulo de conteúdo (@/lib/legal) — trocar o texto não muda esta página. Linkada no
 * /cadastro. Também é referenciada no signup (corrige o /privacidade = 404 atual).
 */
export default function PrivacidadePage() {
  return <LegalDoc doc={POLITICA_PRIVACIDADE} />;
}
