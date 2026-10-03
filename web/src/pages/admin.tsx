import { useCallback, useEffect, useState, type SubmitEvent } from 'react';
import { formatCountdown, formatDateTime, useElections, useNow } from '../components/hooks';
import { OperatorGate, useOperator } from '../components/operator';
import {
  api,
  ApiError,
  STATUS_LABEL,
  type AuditEvent,
  type Candidate,
  type Election,
} from '../lib/api';
import { runKeyCeremony } from '../lib/ceremony';
import { randomCpf } from '../lib/cpf';
import { navigate } from '../lib/router';

export function AdminPage() {
  return (
    <OperatorGate role="admin">
      <AdminConsole />
    </OperatorGate>
  );
}

/** Partes dos trustees geradas NESTA aba (só memória). Em uma eleição real, cada uma iria para uma pessoa. */
type SharesByElection = Record<string, { shares: string[]; threshold: number }>;

function AdminConsole() {
  const { elections, error, reload } = useElections();
  const { signOut } = useOperator('admin');
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [shares, setShares] = useState<SharesByElection>({});
  const current = elections.find((e) => e.id === selected);

  return (
    <>
      <div className="page-head">
        <h1>Administração</h1>
        <button className="button button--quiet" type="button" onClick={signOut}>
          Sair
        </button>
      </div>
      <p className="lede">Prepare a eleição, abra e encerre a votação e faça a apuração.</p>
      {error && <p className="notice notice--error">{error}</p>}
      <div className="split">
        <section aria-labelledby="elections-title">
          <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 id="elections-title" style={{ margin: 0 }}>
              Eleições
            </h2>
            <button
              className="button"
              type="button"
              onClick={() => {
                setCreating(true);
                setSelected(undefined);
              }}
            >
              Nova eleição
            </button>
          </div>
          {elections.length === 0 && (
            <p className="muted">Nenhuma eleição ainda. Crie a primeira.</p>
          )}
          <ul className="election-list">
            {elections.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  aria-current={e.id === selected}
                  onClick={() => {
                    setSelected(e.id);
                    setCreating(false);
                  }}
                >
                  <strong>{e.name}</strong>
                  <span className="status" data-status={e.status}>
                    {STATUS_LABEL[e.status]}
                    {e.ballotEncryption !== 'NONE' && ', votos cifrados'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section>
          {creating && (
            <NewElection
              onCreated={(id, ceremony) => {
                if (ceremony) setShares((s) => ({ ...s, [id]: ceremony }));
                setCreating(false);
                setSelected(id);
                void reload();
              }}
            />
          )}
          {current && (
            <ElectionDetail
              key={current.id}
              election={current}
              ceremony={shares[current.id]}
              onChange={reload}
            />
          )}
          {!creating && !current && (
            <p className="muted">Escolha uma eleição na lista ou crie uma nova.</p>
          )}
        </section>
      </div>
    </>
  );
}

const STARTS_IN = [
  [5, 'Daqui a 5 segundos'],
  [60, 'Daqui a 1 minuto'],
  [300, 'Daqui a 5 minutos'],
] as const;

const DURATION = [
  [30, '30 segundos (teste rápido)'],
  [120, '2 minutos'],
  [600, '10 minutos'],
  [3600, '1 hora'],
] as const;

function NewElection({
  onCreated,
}: {
  onCreated: (id: string, ceremony?: { shares: string[]; threshold: number }) => void;
}) {
  const { token } = useOperator('admin');
  const [name, setName] = useState('Eleição de teste');
  const [startsIn, setStartsIn] = useState(5);
  const [duration, setDuration] = useState(120);
  const [encrypted, setEncrypted] = useState(true);
  const [parts, setParts] = useState(3);
  const [threshold, setThreshold] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const ceremony = encrypted ? await runKeyCeremony(parts, threshold) : undefined;
      const now = Date.now();
      const election = await api<Election>('POST', '/admin/elections', {
        token,
        body: {
          name,
          startsAt: new Date(now + startsIn * 1000).toISOString(),
          endsAt: new Date(now + (startsIn + duration) * 1000).toISOString(),
          ...(ceremony && { encryptionPublicKey: ceremony.publicKey }),
        },
      });
      onCreated(election.id, ceremony && { shares: ceremony.shares, threshold });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <h2>Nova eleição</h2>
      <div className="field">
        <label htmlFor="name">Nome</label>
        <input
          id="name"
          value={name}
          maxLength={200}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </div>
      <div className="inline">
        <div className="field">
          <label htmlFor="starts">Início da votação</label>
          <select
            id="starts"
            value={startsIn}
            onChange={(e) => {
              setStartsIn(Number(e.target.value));
            }}
          >
            {STARTS_IN.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="duration">Duração</label>
          <select
            id="duration"
            value={duration}
            onChange={(e) => {
              setDuration(Number(e.target.value));
            }}
          >
            {DURATION.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="field__hint">
        A votação só pode ser encerrada depois do horário de término: nem a administração encurta a
        eleição.
      </p>
      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={encrypted}
            onChange={(e) => {
              setEncrypted(e.target.checked);
            }}
          />{' '}
          Cifrar os votos
        </label>
        <span className="field__hint">
          A chave da eleição é gerada neste navegador e dividida entre trustees. O servidor recebe
          só a chave pública e não consegue ler nenhum voto antes da apuração.
        </span>
      </div>
      {encrypted && (
        <div className="inline" style={{ marginBottom: 14 }}>
          <div className="field">
            <label htmlFor="parts">Partes</label>
            <input
              id="parts"
              type="number"
              min={2}
              max={9}
              value={parts}
              onChange={(e) => {
                setParts(Number(e.target.value));
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="threshold">Necessárias para apurar</label>
            <input
              id="threshold"
              type="number"
              min={2}
              max={parts}
              value={threshold}
              onChange={(e) => {
                setThreshold(Number(e.target.value));
              }}
            />
          </div>
        </div>
      )}
      {error && <p className="notice notice--error">{error}</p>}
      <button
        className="button"
        type="submit"
        disabled={busy || threshold > parts || threshold < 2}
      >
        {busy ? 'Criando…' : 'Criar eleição'}
      </button>
    </form>
  );
}

function ElectionDetail({
  election,
  ceremony,
  onChange,
}: {
  election: Election;
  ceremony: { shares: string[]; threshold: number } | undefined;
  onChange: () => Promise<void>;
}) {
  const { token } = useOperator('admin');
  const now = useNow();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [c, a] = await Promise.all([
      api<{ candidates: Candidate[] }>('GET', `/elections/${election.id}/candidates`),
      api<{ events: AuditEvent[] }>('GET', `/admin/audit?electionId=${election.id}&limit=500`, {
        token,
      }),
    ]);
    setCandidates(c.candidates);
    setEvents(a.events);
  }, [election.id, token]);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const id = setInterval(() => {
      void refresh();
      void onChange();
    }, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [refresh, onChange]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await Promise.all([refresh(), onChange()]);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const count = (type: string) => events.filter((e) => e.eventType === type).length;
  const sealed = events.find((e) => e.eventType === 'BALLOT_BOX_SEALED');
  const startsIn = new Date(election.startsAt).getTime() - now;
  const endsIn = new Date(election.endsAt).getTime() - now;
  const s = election.status;
  const steps = {
    preparation: s === 'DRAFT' ? 'current' : 'done',
    opening: s === 'DRAFT' ? 'todo' : 'done',
    voting: s === 'DRAFT' ? 'todo' : s === 'OPEN' && endsIn > 0 ? 'current' : 'done',
    closing:
      s === 'CLOSED' || s === 'TALLIED' ? 'done' : s === 'OPEN' && endsIn <= 0 ? 'current' : 'todo',
    tally: s === 'TALLIED' ? 'done' : s === 'CLOSED' ? 'current' : 'todo',
  };

  return (
    <article>
      <h2>{election.name}</h2>
      <p className="muted small">
        <span className="status" data-status={election.status}>
          {STATUS_LABEL[election.status]}
        </span>{' '}
        · votação de {formatDateTime(election.startsAt)} a {formatDateTime(election.endsAt)}
        {election.ballotEncryption !== 'NONE' && ' · votos cifrados (HPKE)'}
      </p>
      {ceremony && election.status === 'DRAFT' && <CeremonyShares ceremony={ceremony} />}
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}

      <ol className="steps">
        <li data-state={steps.preparation}>
          <h3>Preparação</h3>
          {election.status === 'DRAFT' ? (
            <Preparation
              election={election}
              candidates={candidates}
              registered={count('VOTER_REGISTERED')}
              run={run}
            />
          ) : (
            <p className="muted">
              {candidates.length} candidatos e {count('VOTER_REGISTERED')} eleitores. Congelados
              desde a abertura.
            </p>
          )}
        </li>
        <li data-state={steps.opening}>
          <h3>Abertura</h3>
          {election.status === 'DRAFT' ? (
            <button
              className="button"
              type="button"
              disabled={busy || candidates.length === 0 || count('VOTER_REGISTERED') === 0}
              onClick={() =>
                void run(() => api('POST', `/admin/elections/${election.id}/open`, { token }))
              }
            >
              Abrir a eleição
            </button>
          ) : (
            <p className="muted">Aberta.</p>
          )}
        </li>
        <li data-state={steps.voting}>
          <h3>Votação</h3>
          {election.status === 'OPEN' && (
            <p>
              {startsIn > 0
                ? `Começa em ${formatCountdown(startsIn)}.`
                : endsIn > 0
                  ? `Em andamento. Termina em ${formatCountdown(endsIn)}.`
                  : 'Horário encerrado. Já pode encerrar.'}{' '}
              {count('VOTER_AUTHORIZED')} eleitores habilitados até agora.
            </p>
          )}
          <p className="muted small">
            Quantos votaram de fato só aparece no lacre, no encerramento: a urna não emite eventos
            por voto, para que ninguém relacione o horário da habilitação ao do voto.
          </p>
        </li>
        <li data-state={steps.closing}>
          <h3>Encerramento e lacre</h3>
          {election.status === 'OPEN' && (
            <button
              className="button"
              type="button"
              disabled={busy || endsIn > 0}
              onClick={() =>
                void run(() => api('POST', `/admin/elections/${election.id}/close`, { token }))
              }
            >
              {endsIn > 0
                ? `Encerrar (disponível em ${formatCountdown(endsIn)})`
                : 'Encerrar e lacrar a urna'}
            </button>
          )}
          {sealed && (
            <p className="small">
              Urna lacrada com {String(sealed.payload.ballots)} votos e{' '}
              {String(sealed.payload.authorizedWithoutBallot)} habilitados sem voto. Raiz de Merkle{' '}
              <span className="code">{String(sealed.payload.merkleRoot).slice(0, 16)}…</span>,
              assinada.
            </p>
          )}
        </li>
        <li data-state={steps.tally}>
          <h3>Apuração</h3>
          {election.status === 'CLOSED' && (
            <Tally election={election} ceremony={ceremony} busy={busy} run={run} />
          )}
          {election.status === 'TALLIED' && (
            <button
              className="button"
              type="button"
              onClick={() => {
                navigate(`/resultados/${election.id}`);
              }}
            >
              Ver boletim de urna
            </button>
          )}
        </li>
      </ol>
      <AuditCheck />
    </article>
  );
}

function CeremonyShares({ ceremony }: { ceremony: { shares: string[]; threshold: number } }) {
  const download = () => {
    const text = ceremony.shares.map((s, i) => `trustee ${i + 1}: ${s}`).join('\n');
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'partes-dos-trustees.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="shares" role="note">
      <h3>Guarde as partes da chave agora</h3>
      <p className="small">
        A chave para abrir os votos foi dividida em {ceremony.shares.length} partes;{' '}
        {ceremony.threshold} delas apuram a eleição. Elas não estão no servidor. Se forem perdidas,
        os votos nunca poderão ser contados. Esta aba guarda uma cópia só enquanto estiver aberta.
      </p>
      <ol className="code">
        {ceremony.shares.map((share) => (
          <li key={share}>{share}</li>
        ))}
      </ol>
      <button className="button button--quiet" type="button" onClick={download}>
        Baixar as partes (.txt)
      </button>
    </div>
  );
}

function Preparation({
  election,
  candidates,
  registered,
  run,
}: {
  election: Election;
  candidates: Candidate[];
  registered: number;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { token } = useOperator('admin');
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [cpfs, setCpfs] = useState<string[]>([]);

  const addCandidate = (event: SubmitEvent) => {
    event.preventDefault();
    void run(async () => {
      await api('POST', `/admin/elections/${election.id}/candidates`, {
        token,
        body: { number: Number(number), name },
      });
      setNumber('');
      setName('');
    });
  };

  const addTestVoters = () => {
    void run(async () => {
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const cpf = randomCpf();
        await api('POST', `/admin/elections/${election.id}/voters`, {
          token,
          body: { voterIdentifier: cpf },
        });
        created.push(cpf);
      }
      setCpfs((c) => [...c, ...created]);
    });
  };

  return (
    <>
      <form className="inline" onSubmit={addCandidate} style={{ marginBottom: 10 }}>
        <div className="field">
          <label htmlFor="cand-number">Número</label>
          <input
            id="cand-number"
            inputMode="numeric"
            pattern="\d{1,5}"
            size={6}
            value={number}
            onChange={(e) => {
              setNumber(e.target.value.replace(/\D/g, '').slice(0, 5));
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="cand-name">Nome do candidato</label>
          <input
            id="cand-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </div>
        <button className="button" type="submit" disabled={!number || !name.trim()}>
          Cadastrar candidato
        </button>
      </form>
      {candidates.length > 0 && (
        <table className="table" style={{ marginBottom: 14 }}>
          <thead>
            <tr>
              <th scope="col">Número</th>
              <th scope="col">Nome</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => (
              <tr key={c.id}>
                <td>{c.number}</td>
                <td>{c.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        {registered} eleitores cadastrados.{' '}
        <button className="button button--quiet" type="button" onClick={addTestVoters}>
          Cadastrar 5 eleitores de teste
        </button>
      </p>
      {cpfs.length > 0 && (
        <div className="notice">
          <p className="small" style={{ marginTop: 0 }}>
            CPFs de teste cadastrados por esta aba. Use-os no terminal do mesário. O servidor guarda
            só um HMAC de cada um e nunca os devolve: esta lista existe apenas aqui.
          </p>
          <ul className="code">
            {cpfs.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function Tally({
  election,
  ceremony,
  busy,
  run,
}: {
  election: Election;
  ceremony: { shares: string[]; threshold: number } | undefined;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { token } = useOperator('admin');
  const encrypted = election.ballotEncryption !== 'NONE';
  const [shares, setShares] = useState('');
  const list = shares
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const tally = () => {
    void run(async () => {
      await api('POST', `/admin/elections/${election.id}/tally`, {
        token,
        ...(encrypted && { body: { trusteeShares: list } }),
      });
      navigate(`/resultados/${election.id}`);
    });
  };

  return (
    <>
      {encrypted && (
        <div className="field">
          <label htmlFor="shares">Partes dos trustees, uma por linha</label>
          <textarea
            id="shares"
            rows={4}
            className="code"
            value={shares}
            onChange={(e) => {
              setShares(e.target.value);
            }}
          />
          <span className="field__hint">
            Antes de abrir qualquer voto, o servidor confere se as partes reconstroem a chave desta
            eleição.
            {ceremony && (
              <>
                {' '}
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => {
                    setShares(ceremony.shares.slice(0, ceremony.threshold).join('\n'));
                  }}
                >
                  Preencher com as partes desta aba
                </button>
              </>
            )}
          </span>
        </div>
      )}
      <button
        className="button"
        type="button"
        disabled={busy || (encrypted && list.length < 2)}
        onClick={tally}
      >
        Apurar
      </button>
    </>
  );
}

function AuditCheck() {
  const { token } = useOperator('admin');
  const [result, setResult] = useState<{
    valid: boolean;
    eventCount: number;
    failure?: { seq: number; reason: string };
  }>();
  const check = async () => {
    setResult(await api('GET', '/admin/audit/verify', { token }));
  };
  return (
    <section style={{ marginTop: 18 }}>
      <h3>Auditoria</h3>
      <p className="muted small">
        Cada operação acima gerou um evento numa cadeia de hashes. Alterar, apagar ou reordenar
        qualquer evento quebra a cadeia.
      </p>
      <button className="button button--quiet" type="button" onClick={() => void check()}>
        Verificar a cadeia de auditoria
      </button>
      {result && (
        <p className={`notice ${result.valid ? 'notice--ok' : 'notice--error'}`} role="status">
          {result.valid
            ? `Cadeia íntegra: ${result.eventCount} eventos conferidos.`
            : `Cadeia quebrada no evento ${result.failure?.seq ?? '?'} (${result.failure?.reason ?? ''}).`}
        </p>
      )}
    </section>
  );
}
