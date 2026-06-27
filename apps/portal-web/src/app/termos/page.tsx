import { LegalDoc } from '@/components/legal/legal-doc';
import { TERMOS_DE_USO } from '@/lib/legal';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Termos de Uso · Startap',
  description: 'Termos de Uso da plataforma Startap.',
};

/**
 * Rota PÚBLICA /termos (SCRUM-1). Renderiza os Termos de Uso a partir do módulo de
 * conteúdo (@/lib/legal) — trocar o texto não muda esta página. Linkada no /cadastro.
 */
export default function TermosPage() {
  return <LegalDoc doc={TERMOS_DE_USO} />;
}
