import { getServerSession } from '@/lib/server-auth';
import { redirect } from 'next/navigation';

/** Raiz: manda logado pra /inicio, deslogado pro /login. */
export default async function RootPage() {
  const session = await getServerSession();
  redirect(session ? '/inicio' : '/login');
}
