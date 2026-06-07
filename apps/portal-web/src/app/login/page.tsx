import { getServerSession } from '@/lib/server-auth';
import { redirect } from 'next/navigation';
import { LoginForm } from './login-form';

/** Se ja logado, pula o login. Senao renderiza o form (client). */
export default async function LoginPage() {
  const session = await getServerSession();
  if (session) redirect('/inicio');
  return <LoginForm />;
}
