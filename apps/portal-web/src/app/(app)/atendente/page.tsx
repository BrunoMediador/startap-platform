import { redirect } from 'next/navigation';

/** `/atendente` sem sub-rota -> primeira aba (Personalidade). */
export default function AtendentePage() {
  redirect('/atendente/personalidade');
}
