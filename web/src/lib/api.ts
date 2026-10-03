/** Cliente da API. Tudo passa pelo proxy /api do Vite (mesma origem, sem CORS). */

export type ElectionStatus = 'DRAFT' | 'OPEN' | 'CLOSED' | 'TALLIED';

export interface Election {
  id: string;
  name: string;
  status: ElectionStatus;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  ballotEncryption: 'NONE' | 'HPKE-X25519-HKDFSHA256-AES256GCM';
  encryptionPublicKey: string | null;
}

export interface Candidate {
  id: string;
  electionId: string;
  number: number;
  name: string;
}

export interface AuditEvent {
  seq: number;
  eventType: string;
  actorType: string;
  actorIdentifier: string;
  electionId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type Choice = { type: 'candidate'; number: number } | { type: 'blank' } | { type: 'null' };

/** Mensagens em português para os códigos estáveis da API; o detalhe técnico vem junto. */
const MESSAGES: Record<string, string> = {
  UNAUTHORIZED: 'Credencial inválida ou ausente.',
  VALIDATION_ERROR: 'Algum campo está em formato inválido.',
  NOT_FOUND: 'Não encontrado.',
  CONFLICT: 'A operação não é permitida no estado atual.',
  BUSINESS_RULE_VIOLATION: 'A operação viola uma regra da eleição.',
  INTEGRITY_FAILURE:
    'A verificação de integridade falhou: os dados não batem com o lacre ou as assinaturas.',
  RATE_LIMITED: 'Muitas requisições. Aguarde um minuto.',
  INTERNAL_ERROR: 'Erro interno do servidor.',
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${MESSAGES[code] ?? 'Erro inesperado.'} (${detail})`);
  }
}

interface RequestOptions {
  token?: string | undefined;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function api<T>(
  method: 'GET' | 'POST',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK',
      'sem conexão com a API — o backend está rodando (npm run dev)?',
    );
  }

  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? response.statusText,
    );
  }
  return data as T;
}

export const STATUS_LABEL: Record<ElectionStatus, string> = {
  DRAFT: 'Em preparação',
  OPEN: 'Aberta',
  CLOSED: 'Encerrada',
  TALLIED: 'Apurada',
};
