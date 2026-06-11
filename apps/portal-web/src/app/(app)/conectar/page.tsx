import { Suspense } from 'react';
import { ConectarClient } from './conectar-client';

/**
 * Conectar/Reconectar WhatsApp (reconexao self-service). Tela client inteira —
 * estado, polling e copia-codigo vivem no ConectarClient. O <Suspense> e exigido
 * pelo useSearchParams (le `?auto=1` do banner). A feature e gated: o
 * ConectarClient checa GET /portal/conexao.enabled e mostra "indisponivel" se OFF
 * (o item de menu ja some nesse caso, mas a URL direta tambem fica protegida).
 */
export default function ConectarPage() {
  return (
    <Suspense fallback={null}>
      <ConectarClient />
    </Suspense>
  );
}
