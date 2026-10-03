import { useCallback, useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useElections } from '../components/hooks';
import { api, ApiError, type Candidate, type Choice, type Election } from '../lib/api';
import { openBoothChannel } from '../lib/booth-channel';
import { Link } from '../lib/router';

interface Session {
  electionId: string;
  electionName: string;
  token: string;
  candidates: Candidate[];
  digits: number;
}

type Phase =
  | { kind: 'locked'; message?: string }
  | { kind: 'voting'; session: Session; typed: string }
  | { kind: 'blank'; session: Session }
  | { kind: 'sending'; session: Session }
  | { kind: 'done' };

const OFFICE = 'Candidato';

/** O som do fim do voto. Curto, e só depois de um voto confirmado. */
function beep() {
  try {
    const audio = new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 1150;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.7);
  } catch {
    // sem áudio disponível: segue em silêncio
  }
}

async function loadSession(electionId: string, token: string): Promise<Session> {
  const [election, list] = await Promise.all([
    api<Election>('GET', `/elections/${electionId}`),
    api<{ candidates: Candidate[] }>('GET', `/elections/${electionId}/candidates`),
  ]);
  const digits = Math.max(1, ...list.candidates.map((c) => String(c.number).length));
  return { electionId, electionName: election.name, token, candidates: list.candidates, digits };
}

export function BoothPage() {
  const [phase, setPhase] = useState<Phase>({ kind: 'locked' });
  const channel = useRef<ReturnType<typeof openBoothChannel>>(null);
  const idempotencyKey = useRef<string>(null);

  const release = useCallback(async (electionId: string, token: string) => {
    try {
      setPhase({ kind: 'voting', session: await loadSession(electionId, token), typed: '' });
    } catch (e) {
      setPhase({ kind: 'locked', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    channel.current = openBoothChannel((message) => {
      if (message.type !== 'release') return;
      channel.current?.send({ type: 'ack' });
      void release(message.electionId, message.token);
    });
    return () => {
      channel.current?.close();
    };
  }, [release]);

  const press = useCallback((key: string) => {
    setPhase((p) => {
      if (p.kind === 'voting' && /^\d$/.test(key) && p.typed.length < p.session.digits) {
        return { ...p, typed: p.typed + key };
      }
      if (key === 'CORRIGE' && (p.kind === 'voting' || p.kind === 'blank')) {
        return { kind: 'voting', session: p.session, typed: '' };
      }
      // Como na urna real: BRANCO só vale antes de digitar qualquer número.
      if (key === 'BRANCO' && p.kind === 'voting' && p.typed === '')
        return { kind: 'blank', session: p.session };
      return p;
    });
  }, []);

  const confirm = useCallback(async () => {
    if (phase.kind !== 'voting' && phase.kind !== 'blank') return;
    if (phase.kind === 'voting' && phase.typed.length < phase.session.digits) return;
    const { session } = phase;
    let choice: Choice;
    if (phase.kind === 'blank') choice = { type: 'blank' };
    else {
      const number = Number(phase.typed);
      choice = session.candidates.some((c) => c.number === number)
        ? { type: 'candidate', number }
        : { type: 'null' };
    }

    // Uma chave por intenção de voto: se a rede falhar, o retry não cria um segundo voto.
    idempotencyKey.current ??= crypto.randomUUID();
    setPhase({ kind: 'sending', session });
    for (let attempt = 1; ; attempt++) {
      try {
        await api('POST', '/ballots', {
          token: session.token,
          body: { electionId: session.electionId, choice },
          headers: { 'idempotency-key': idempotencyKey.current },
        });
        break;
      } catch (e) {
        const retryable = e instanceof ApiError && (e.status === 0 || e.status >= 500);
        if (retryable && attempt < 3) continue;
        idempotencyKey.current = null;
        setPhase({ kind: 'locked', message: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
    idempotencyKey.current = null;
    beep();
    channel.current?.send({ type: 'voted' });
    setPhase({ kind: 'done' });
    setTimeout(() => {
      setPhase({ kind: 'locked' });
    }, 4000);
  }, [phase]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      if (/^\d$/.test(event.key)) press(event.key);
      else if (event.key === 'Backspace' || event.key === 'Delete') press('CORRIGE');
      else if (event.key.toLowerCase() === 'b') press('BRANCO');
      else if (event.key === 'Enter') void confirm();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [press, confirm]);

  return (
    <div className="booth-wrap">
      <div className="urna">
        <section className="urna__screen" aria-label="Tela da urna">
          <Screen phase={phase} />
        </section>
        <div className="urna__panel">
          <p className="urna__brand">Também dá para votar pelo teclado do computador.</p>
          <div className="keypad" role="group" aria-label="Teclado da urna">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d) => (
              <button
                key={d}
                type="button"
                className={`key${d === '0' ? ' key--zero' : ''}`}
                onClick={() => {
                  press(d);
                }}
              >
                {d}
              </button>
            ))}
            <div className="actions">
              <button
                type="button"
                className="action action--blank"
                onClick={() => {
                  press('BRANCO');
                }}
              >
                BRANCO
              </button>
              <button
                type="button"
                className="action action--correct"
                onClick={() => {
                  press('CORRIGE');
                }}
              >
                CORRIGE
              </button>
              <button
                type="button"
                className="action action--confirm"
                onClick={() => void confirm()}
              >
                CONFIRMA
              </button>
            </div>
          </div>
        </div>
      </div>
      <Announcer phase={phase} />
      {phase.kind === 'locked' && <ManualRelease onRelease={release} />}
      <p className="small">
        <Link href="/">Sair da urna</Link>
      </p>
    </div>
  );
}

function Screen({ phase }: { phase: Phase }) {
  if (phase.kind === 'locked') {
    return (
      <div className="urna__locked">
        <p>Urna bloqueada.</p>
        <p>Aguardando a liberação do mesário.</p>
        {phase.message && (
          <p style={{ color: 'var(--danger)', fontSize: '0.95rem' }}>{phase.message}</p>
        )}
      </div>
    );
  }
  if (phase.kind === 'done') return <p className="urna__fim">FIM</p>;
  if (phase.kind === 'sending') return <p className="urna__big">Gravando…</p>;

  const { session } = phase;
  const typed = phase.kind === 'voting' ? phase.typed : '';
  const complete = phase.kind === 'voting' && typed.length === session.digits;
  const candidate = complete
    ? session.candidates.find((c) => c.number === Number(typed))
    : undefined;

  return (
    <>
      <p className="urna__title">SEU VOTO PARA</p>
      <p className="urna__office">{OFFICE}</p>
      {phase.kind === 'blank' ? (
        <p className="urna__big">VOTO EM BRANCO</p>
      ) : (
        <>
          <div className="urna__number">
            <span>Número:</span>
            <span className="urna__digits">
              {Array.from({ length: session.digits }, (_, i) => (
                <span key={i} className="urna__digit" data-cursor={i === typed.length}>
                  {typed[i] ?? ''}
                </span>
              ))}
            </span>
          </div>
          {complete && candidate && <p className="urna__name">Nome: {candidate.name}</p>}
          {complete && !candidate && (
            <>
              <p className="urna__name">NÚMERO ERRADO</p>
              <p className="urna__big">VOTO NULO</p>
            </>
          )}
        </>
      )}
      {(complete || phase.kind === 'blank') && (
        <div className="urna__help">
          Aperte a tecla:
          <br />
          CONFIRMA para CONFIRMAR este voto
          <br />
          CORRIGE para REINICIAR este voto
        </div>
      )}
    </>
  );
}

/** Narra o estado da tela para leitores de tela. */
function Announcer({ phase }: { phase: Phase }) {
  let text = '';
  if (phase.kind === 'locked') text = 'Urna bloqueada. Aguardando a liberação do mesário.';
  if (phase.kind === 'blank')
    text = 'Voto em branco. Aperte confirma para confirmar ou corrige para reiniciar.';
  if (phase.kind === 'sending') text = 'Gravando o voto.';
  if (phase.kind === 'done') text = 'Fim. Voto registrado.';
  if (phase.kind === 'voting') {
    const candidate = phase.session.candidates.find((c) => c.number === Number(phase.typed));
    text =
      phase.typed.length < phase.session.digits
        ? `Digite o número do candidato. ${phase.typed.split('').join(' ')}`
        : candidate
          ? `Número ${phase.typed.split('').join(' ')}, ${candidate.name}. Aperte confirma ou corrige.`
          : 'Número errado. Voto nulo. Aperte confirma ou corrige.';
  }
  return (
    <p className="sr-only" aria-live="assertive">
      {text}
    </p>
  );
}

function ManualRelease({
  onRelease,
}: {
  onRelease: (electionId: string, token: string) => Promise<void>;
}) {
  const { elections } = useElections();
  const open = elections.filter((e) => e.status === 'OPEN');
  const [electionId, setElectionId] = useState('');
  const [token, setToken] = useState('');
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    void onRelease(electionId || open[0]?.id || '', token.trim());
  };
  return (
    <details className="booth-manual">
      <summary>Liberar com um token (sem o terminal do mesário nesta janela)</summary>
      <form className="inline" onSubmit={submit} style={{ marginTop: 10 }}>
        <div className="field">
          <label htmlFor="manual-election">Eleição</label>
          <select
            id="manual-election"
            value={electionId}
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
        <div className="field">
          <label htmlFor="manual-token">Token de votação</label>
          <input
            id="manual-token"
            autoComplete="off"
            size={46}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
            }}
          />
        </div>
        <button
          className="button"
          type="submit"
          disabled={!/^[A-Za-z0-9_-]{43}$/.test(token.trim()) || open.length === 0}
        >
          Liberar
        </button>
      </form>
    </details>
  );
}
