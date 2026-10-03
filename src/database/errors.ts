import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { AppError, ConflictError } from '../shared/errors/app-error.js';

/** SQLSTATEs que a aplicação trata. Os da classe "UE" vêm dos triggers das migrations. */
export const SqlState = {
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  INVALID_ELECTION_TRANSITION: 'UE001',
  ELECTION_FROZEN: 'UE002',
  ELECTION_NOT_DRAFT: 'UE003',
  VOTER_IMMUTABLE: 'UE004',
  ELECTION_NOT_OPEN: 'UE005',
  SESSION_IMMUTABLE: 'UE006',
  AUTHORIZATION_UNBALANCED: 'UE007',
  BALLOT_IMMUTABLE: 'UE008',
  BALLOT_UNBALANCED: 'UE009',
  AUDIT_IMMUTABLE: 'UE010',
  AUDIT_CHAIN_BROKEN: 'UE011',
  TALLY_IMMUTABLE: 'UE012',
  BALLOT_FORMAT_MISMATCH: 'UE013',
} as const;

const driverCauseSchema = z.object({
  driverAdapterError: z.object({
    cause: z.object({
      originalCode: z.string().optional(),
      constraint: z.object({ index: z.string().optional() }).optional(),
    }),
  }),
});

interface DatabaseErrorInfo {
  sqlState?: string;
  constraint?: string;
}

export function inspectDatabaseError(error: unknown): DatabaseErrorInfo | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const parsed = driverCauseSchema.safeParse(error.meta);
  if (!parsed.success) return {};

  const { originalCode, constraint } = parsed.data.driverAdapterError.cause;
  return {
    ...(originalCode && { sqlState: originalCode }),
    ...(constraint?.index && { constraint: constraint.index }),
  };
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const info = inspectDatabaseError(error);
  return info?.sqlState === SqlState.UNIQUE_VIOLATION && info.constraint === constraint;
}

/**
 * Violações das invariantes de estado garantidas pelo banco. Normalmente a aplicação já
 * barrou antes; chegar aqui significa uma corrida que o banco serializou.
 */
export function mapDatabaseError(error: unknown): AppError | undefined {
  switch (inspectDatabaseError(error)?.sqlState) {
    case SqlState.INVALID_ELECTION_TRANSITION:
    case SqlState.ELECTION_FROZEN:
    case SqlState.ELECTION_NOT_DRAFT:
    case SqlState.ELECTION_NOT_OPEN:
      return new ConflictError('Election state does not allow this operation');
    case SqlState.VOTER_IMMUTABLE:
      return new ConflictError('Voter record cannot be changed this way');
    case SqlState.SESSION_IMMUTABLE:
      return new ConflictError('Voting session cannot be changed this way');
    case SqlState.BALLOT_IMMUTABLE:
      return new ConflictError('Ballots cannot be changed');
    default:
      return undefined;
  }
}

/**
 * O que é seguro logar de um erro de banco. Mensagens do PostgreSQL podem conter a linha
 * inteira ("Failing row contains (...)"), o que, numa tabela de votos, seria o próprio voto.
 */
export function describeDatabaseError(error: unknown): Record<string, string> | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const info = inspectDatabaseError(error);
  return {
    name: error.name,
    prismaCode: error.code,
    ...(info?.sqlState && { sqlState: info.sqlState }),
  };
}
