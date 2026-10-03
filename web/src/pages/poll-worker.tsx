import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { formatCountdown, useElections, useNow } from '../components/hooks';
import { OperatorGate, useOperator } from '../components/operator';
import { api } from '../lib/api';
import { openBoothChannel, type BoothMessage } from '../lib/booth-channel';
import { formatCpf } from '../lib/cpf';

export function PollWorkerPage() {
  return (
    <OperatorGate role="pollWorker">
      <Terminal />
    </OperatorGate>
  );
}

type Display =
  | { kind: 'idle' }
  | { kind: 'released'; token: string; electionId: string; boothAck: boolean | undefined }
  | { kind: 'voted' }
  | { kind: 'error'; message: string };

function Terminal() {
  const { token, signOut } = useOperator('pollWorker');
  const { elections } = useElections();
  const open = elections.filter((e) => e.status === 'OPEN');
  const [electionId, setElectionId] = useState<string>();
  const [cpf, setCpf] = useState('');
  const [display, setDisplay] = useState<Display>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const channel = useRef<ReturnType<typeof openBoothChannel>>(null);
  const now = useNow();

  const selected = open.find((e) => e.id === electionId) ?? open[0];
  const startsIn = selected ? new Date(selected.startsAt).getTime() - now : 0;

  useEffect(() => {
    channel.current = openBoothChannel((message: BoothMessage) => {
      if (message.type === 'ack') {
        setDisplay((d) => (d.kind === 'released' ? { ...d, boothAck: true } : d));
      }
      if (message.type === 'voted') setDisplay({ kind: 'voted' });
    });
    return () => {
      channel.current?.close();
    };
  }, []);

  const authorize = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    try {
      const issued = await api<{ token: string; expiresAt: string }>(
        'POST',
        `/elections/${selected.id}/voting-sessions`,
        { token, body: { voterIdentifier: cpf } },
      );
      setCpf('');
      setDisplay({
        kind: 'released',
        token: issued.token,
        electionId: selected.id,
        boothAck: undefined,
      });
      channel.current?.send({
        type: 'release',
        electionId: selected.id,
        token: issued.token,
        expiresAt: issued.expiresAt,
      });
      setTimeout(() => {
        setDisplay((d) =>
          d.kind === 'released' && d.boothAck === undefined ? { ...d, boothAck: false } : d,
        );
      }, 1000);
    } catch (e) {
      setDisplay({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Terminal do mesário</h1>
        <button className="button button--quiet" type="button" onClick={signOut}>
          Sair
        </button>
      </div>
      <p className="lede">
        Confira o documento do eleitor, digite o CPF e libere a urna. O mesário sabe quem vai votar,
        mas a urna nunca recebe o CPF.
      </p>

      {open.length === 0 ? (
        <p className="notice">Nenhuma eleição aberta. Abra uma na administração.</p>
      ) : (
        <form className="terminal" onSubmit={(e) => void authorize(e)}>
          {open.length > 1 && (
            <div className="field">
              <label htmlFor="election">Eleição</label>
              <select
                id="election"
                value={selected?.id}
                onChange={(e) => {
                  setElectionId(e.target.value);
                }}
              >
                {open.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="terminal__display" role="status" aria-live="polite">
            <strong>{selected?.name}</strong>
            <TerminalMessage display={display} startsIn={startsIn} />
          </div>
          <div className="field">
            <label htmlFor="cpf">CPF do eleitor</label>
            <input
              id="cpf"
              className="terminal__cpf"
              inputMode="numeric"
              autoComplete="off"
              placeholder="000.000.000-00"
              value={cpf}
              onChange={(e) => {
                setCpf(formatCpf(e.target.value));
              }}
            />
          </div>
          <button
            className="button"
            type="submit"
            disabled={busy || cpf.length !== 14 || startsIn > 0}
          >
            Liberar a urna
          </button>
        </form>
      )}
    </>
  );
}

function TerminalMessage({ display, startsIn }: { display: Display; startsIn: number }) {
  if (startsIn > 0) return <p>A votação começa em {formatCountdown(startsIn)}.</p>;
  switch (display.kind) {
    case 'idle':
      return <p>Aguardando o próximo eleitor.</p>;
    case 'voted':
      return <p>Voto registrado. A urna voltou a ficar bloqueada.</p>;
    case 'error':
      return <p style={{ color: 'var(--danger)' }}>{display.message}</p>;
    case 'released':
      return (
        <>
          <p>
            Eleitor habilitado. {display.boothAck === true && 'A urna recebeu a liberação.'}
            {display.boothAck === false &&
              'Nenhuma urna aberta neste navegador recebeu a liberação.'}
          </p>
          {display.boothAck === false && (
            <details>
              <summary>Liberar a urna manualmente</summary>
              <p className="small">
                Abra a página da urna e cole este token de uso único. Ele expira em minutos e vale
                um único voto.
              </p>
              <p className="code">{display.token}</p>
            </details>
          )}
        </>
      );
  }
}
