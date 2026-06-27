import { COLABORADOR_HOME } from '@/lib/colaborador';
import { getServerColaboradorSession, getServerSession } from '@/lib/server-auth';
import { redirect } from 'next/navigation';
import { LoginForm } from './login-form';

/** Se ja logado, pula o login (dono -> /inicio; colaborador -> agenda read-only).
 *  Senao renderiza o form (client). */
export default async function LoginPage() {
  const session = await getServerSession();
  if (session) redirect('/inicio');
  // SCRUM-32: sessão de colaborador não casa /auth/me (owner-only); checa a dele.
  const colaborador = await getServerColaboradorSession();
  if (colaborador) redirect(COLABORADOR_HOME);
  return <LoginForm />;
}
