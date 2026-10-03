import { useEffect, useState } from 'react';
import { formatDateTime, useElections } from '../components/hooks';
import { api, STATUS_LABEL, type Election } from '../lib/api';
import { Link } from '../lib/router';
import {
  verifyPublished,
  type Check,
  type PublishedBallot,
  type PublishedTally,
} from '../lib/verify';

export function ResultsPage({ electionId }: { electionId: string | undefined }) {
  return electionId ? <Bulletin electionId={electionId} /> : <ResultsList />;
}

function ResultsList() {
  const { elections } = useElections();
  return (
    <>
      <h1>Resultados</h1>
      <p className="lede">
        O resultado só é publicado depois da apuração. Antes disso, nem a administração vê contagens
        parciais.
      </p>
      <table className="table" style={{ maxWidth: 760 }}>
        <thead>
          <tr>
            <th scope="col">Eleição</th>
            <th scope="col">Situação</th>
          </tr>
        </thead>
        <tbody>
          {elections.map((e) => (
            <tr key={e.id}>
              <td>
                {e.status === 'TALLIED' ? (
                  <Link href={`/resultados/${e.id}`}>{e.name}</Link>
                ) : (
                  e.name
                )}
              </td>
              <td>
                <span className="status" data-status={e.status}>
                  {STATUS_LABEL[e.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

interface Published {
  election: Election;
  tally:
    | (PublishedTally & {
        electionName: string;
        talliedAt: string;
        turnout: Record<string, number>;
      })
    | undefined;
  ballots: PublishedBallot[];
}

function Bulletin({ electionId }: { electionId: string }) {
  const [data, setData] = useState<Published>();
  const [error, setError] = useState<string>();
  const [checks, setChecks] = useState<Check[]>();
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const election = await api<Election>('GET', `/elections/${electionId}`);
        if (election.status !== 'TALLIED') {
          setData({ election, tally: undefined, ballots: [] });
          return;
        }
        const [tally, ballots] = await Promise.all([
          api<NonNullable<Published['tally']>>('GET', `/elections/${electionId}/tally`),
          api<{ ballots: PublishedBallot[] }>('GET', `/elections/${electionId}/ballots`),
        ]);
        setData({ election, tally, ballots: ballots.ballots });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [electionId]);

  if (error) return <p className="notice notice--error">{error}</p>;
  if (!data) return <p className="muted">Carregando…</p>;
  if (!data.tally) {
    return (
      <p className="notice">
        {data.election.name}: {STATUS_LABEL[data.election.status].toLowerCase()}. O boletim só
        existe depois da apuração.
      </p>
    );
  }

  const { tally, ballots } = data;
  const max = Math.max(1, ...tally.result.candidates.map((c) => c.votes));
  const verify = async () => {
    setVerifying(true);
    setChecks(await verifyPublished(tally, ballots));
    setVerifying(false);
  };

  return (
    <>
      <article className="receipt" aria-label="Boletim de urna">
        <h2>BOLETIM DE URNA</h2>
        <p style={{ textAlign: 'center', margin: 0 }}>{tally.electionName}</p>
        <hr />
        <p style={{ margin: 0 }}>Apurado em {formatDateTime(tally.talliedAt)}</p>
        <p style={{ margin: 0 }}>
          {ballots.length > 0 && ballots[0]?.ciphertext
            ? 'Votos cifrados (HPKE)'
            : 'Votos em claro'}
        </p>
        <hr />
        {tally.result.candidates.map((c) => (
          <div key={c.candidateId}>
            <div className="receipt__row">
              <span>
                {c.number} {c.name}
              </span>
              <span aria-hidden="true" />
              <span>{c.votes}</span>
            </div>
            <div className="bars" aria-hidden="true">
              <div className="bars__bar" style={{ width: `${(c.votes / max) * 100}%` }} />
            </div>
          </div>
        ))}
        <div className="receipt__row">
          <span>Brancos</span>
          <span aria-hidden="true" />
          <span>{tally.result.blank}</span>
        </div>
        <div className="receipt__row">
          <span>Nulos</span>
          <span aria-hidden="true" />
          <span>{tally.result.null}</span>
        </div>
        <hr />
        <div className="receipt__row">
          <span>Total de votos</span>
          <span aria-hidden="true" />
          <span>{tally.result.totalBallots}</span>
        </div>
        <div className="receipt__row">
          <span>Eleitores aptos</span>
          <span aria-hidden="true" />
          <span>{tally.turnout.registeredVoters}</span>
        </div>
        <div className="receipt__row">
          <span>Habilitados sem voto</span>
          <span aria-hidden="true" />
          <span>{tally.turnout.authorizedWithoutBallot}</span>
        </div>
        <hr />
        <p style={{ margin: 0, wordBreak: 'break-all' }}>Raiz de Merkle {tally.merkleRoot}</p>
        <p style={{ margin: 0 }}>Chave de assinatura {tally.keyId}</p>
        {checks && (
          <>
            <hr />
            <p style={{ margin: 0 }}>Verificação feita neste navegador:</p>
            {checks.map((c) => (
              <p key={c.label} className="receipt__check" data-ok={c.ok} style={{ margin: 0 }}>
                {c.ok ? '[ok]' : '[FALHOU]'} {c.label}
              </p>
            ))}
            <p className="receipt__final" role="status">
              {checks.every((c) => c.ok) ? 'RESULTADO CONFERIDO' : 'RESULTADO NÃO CONFERE'}
            </p>
          </>
        )}
      </article>
      <div className="receipt__actions">
        <button className="button" type="button" disabled={verifying} onClick={() => void verify()}>
          {verifying ? 'Verificando…' : 'Verificar este resultado no navegador'}
        </button>
      </div>
      <p className="muted small" style={{ maxWidth: '62ch', margin: '0 auto' }}>
        A verificação usa só dados públicos e uma implementação independente, escrita com a
        criptografia do próprio navegador: confere as assinaturas, recalcula cada um dos{' '}
        {ballots.length} votos publicados, a raiz de Merkle e a contagem.
      </p>
    </>
  );
}
