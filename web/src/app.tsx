import { OperatorProvider } from './components/operator';
import { Link, usePath } from './lib/router';
import { AdminPage } from './pages/admin';
import { BoothPage } from './pages/booth';
import { HomePage } from './pages/home';
import { PollWorkerPage } from './pages/poll-worker';
import { ResultsPage } from './pages/results';

const NAV = [
  ['/administracao', 'Administração'],
  ['/mesario', 'Mesário'],
  ['/urna', 'Urna'],
  ['/resultados', 'Resultados'],
] as const;

function route(path: string) {
  if (path.startsWith('/administracao')) return <AdminPage />;
  if (path.startsWith('/mesario')) return <PollWorkerPage />;
  if (path.startsWith('/urna')) return <BoothPage />;
  if (path.startsWith('/resultados')) return <ResultsPage electionId={path.split('/')[2]} />;
  return <HomePage />;
}

export function App() {
  const path = usePath();
  // A urna ocupa a tela inteira, como numa cabine: sem menu.
  const isBooth = path.startsWith('/urna');
  return (
    <OperatorProvider>
      {!isBooth && (
        <header className="topbar">
          <Link href="/" className="topbar__name">
            Urna educacional
          </Link>
          <nav aria-label="Seções">
            {NAV.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                aria-current={path.startsWith(href) ? 'page' : undefined}
              >
                {label}
              </Link>
            ))}
          </nav>
          <span className="topbar__warning">Ambiente de estudo. Não use em eleições reais.</span>
        </header>
      )}
      <main>{route(path)}</main>
    </OperatorProvider>
  );
}
