import { redirect } from 'next/navigation';

/** `/negocio` sem sub-rota -> primeira aba (Dados), sempre visível/sem gate. */
export default function NegocioPage() {
  redirect('/negocio/dados');
}
