import { useCallback, useEffect, useState } from 'react';
import { api, type Election } from '../lib/api';

/** Relógio que atualiza a cada segundo (contagens regressivas). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

export function useElections(pollMs = 5000) {
  const [elections, setElections] = useState<Election[]>([]);
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    try {
      setElections((await api<{ elections: Election[] }>('GET', '/elections')).elections);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  // Carga inicial e atualização periódica em callbacks de timer (não no corpo do efeito).
  useEffect(() => {
    const first = setTimeout(() => void reload(), 0);
    const id = setInterval(() => void reload(), pollMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [reload, pollMs]);
  return { elections, error, reload };
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
}
