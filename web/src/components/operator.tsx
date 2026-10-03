import { createContext, useContext, useState, type SubmitEvent, type ReactNode } from 'react';

/**
 * Tokens de operador ficam SÓ na memória da página: nada de localStorage (um XSS os levaria)
 * nem de URL. Recarregar a página pede o token de novo, de propósito.
 */
type Role = 'admin' | 'pollWorker';
type Tokens = Partial<Record<Role, string>>;

const OperatorContext = createContext<{
  tokens: Tokens;
  set: (role: Role, token?: string) => void;
} | null>(null);

export function OperatorProvider({ children }: { children: ReactNode }) {
  const [tokens, setTokens] = useState<Tokens>({});
  const set = (role: Role, token?: string) => {
    setTokens((current) => ({ ...current, [role]: token }));
  };
  return <OperatorContext value={{ tokens, set }}>{children}</OperatorContext>;
}

export function useOperator(role: Role) {
  const context = useContext(OperatorContext);
  if (!context) throw new Error('OperatorProvider missing');
  return {
    token: context.tokens[role],
    signOut: () => {
      context.set(role);
    },
    signIn: (token: string) => {
      context.set(role, token);
    },
  };
}

const ROLE_TEXT: Record<Role, { title: string; hint: string }> = {
  admin: {
    title: 'Entrar como administração',
    hint: 'Em desenvolvimento, o token está no .env, no comentário acima de ADMIN_CREDENTIALS.',
  },
  pollWorker: {
    title: 'Entrar como mesário',
    hint: 'Em desenvolvimento, o token está no .env, no comentário acima de POLL_WORKER_CREDENTIALS.',
  },
};

export function OperatorGate({ role, children }: { role: Role; children: ReactNode }) {
  const { token, signIn } = useOperator(role);
  const [value, setValue] = useState('');
  if (token) return <>{children}</>;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (/^[A-Za-z0-9_-]{43}$/.test(value.trim())) signIn(value.trim());
  };
  const valid = /^[A-Za-z0-9_-]{43}$/.test(value.trim());
  return (
    <form onSubmit={submit} style={{ maxWidth: 520 }}>
      <h1>{ROLE_TEXT[role].title}</h1>
      <p className="lede">{ROLE_TEXT[role].hint} O token fica só na memória desta aba.</p>
      <div className="field">
        <label htmlFor="operator-token">Token</label>
        <input
          id="operator-token"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
          }}
          aria-describedby="operator-token-hint"
        />
        <span id="operator-token-hint" className="field__hint">
          43 caracteres. A API recusa qualquer outro formato.
        </span>
      </div>
      <button className="button" type="submit" disabled={!valid}>
        Entrar
      </button>
    </form>
  );
}
