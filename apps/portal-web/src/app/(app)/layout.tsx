import { BottomNav } from '@/components/shell/bottom-nav';
import { SessionProvider } from '@/components/shell/session-context';
import { Sidebar } from '@/components/shell/sidebar';
import { Topbar } from '@/components/shell/topbar';
import { getServerBusinessName, getServerSession } from '@/lib/server-auth';
import { redirect } from 'next/navigation';

/**
 * Shell do app autenticado (spec 2). Guard server-side: sem sessao -> /login.
 * Layout: mobile = topbar + scroll + bottom nav; >=md = sidebar lateral + topo.
 * O business name vem do /portal/status (server) com fallback no slot.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect('/login');

  const businessName = await getServerBusinessName(session.slot);

  return (
    <SessionProvider slot={session.slot} username={session.username}>
      {/* Shell em flex row (1.D.7): sidebar e a coluna de conteudo sao IRMAOS.
          A pagina inteira rola; a sidebar fica sticky/h-dvh com rodape sempre
          visivel (fix do BLOCO A — antes esticava com o conteudo).
          SEM bg-bg aqui: o `body` ja pinta `--color-bg` (no-op visual em todas
          as rotas). Deixar o shell transparente permite que o fundo fixo da
          Inicio (canvas fullbg, z-index:-1) apareca nos vaos atras do conteudo;
          nas outras rotas o canvas nem monta, entao nada muda. */}
      <div className="flex min-h-dvh">
        <Sidebar businessName={businessName} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar businessName={businessName} />
          <main className="mx-auto w-full max-w-[720px] flex-1 px-5 pb-24 pt-[18px] md:pb-12">
            {children}
          </main>
          <BottomNav />
        </div>
      </div>
    </SessionProvider>
  );
}
