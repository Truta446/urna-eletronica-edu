import type { PrismaClient } from '../../../database/client.js';
import type { Clock } from '../../../shared/clock.js';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from '../../../shared/errors/app-error.js';
import { validateNewSchedule, type Election, type ElectionStatus } from '../domain/election.js';

export interface ElectionServiceDeps {
  prisma: PrismaClient;
  clock: Clock;
}

export interface CreateElectionInput {
  name: string;
  startsAt: Date;
  endsAt: Date;
}

const electionSelect = {
  id: true,
  name: true,
  status: true,
  startsAt: true,
  endsAt: true,
  createdAt: true,
} as const;

export function createElectionService({ prisma, clock }: ElectionServiceDeps) {
  async function get(id: string): Promise<Election> {
    const election = await prisma.election.findUnique({ where: { id }, select: electionSelect });
    if (!election) throw new NotFoundError('Election');
    return election;
  }

  function wrongStatus(actual: ElectionStatus, expected: ElectionStatus): ConflictError {
    return new ConflictError(`Election is ${actual}, expected ${expected}`);
  }

  async function create(input: CreateElectionInput): Promise<Election> {
    validateNewSchedule(input, clock.now());
    return prisma.election.create({ data: input, select: electionSelect });
  }

  /**
   * A transição é um único UPDATE condicional: verificar e alterar acontecem atomicamente
   * no banco. Se nada for alterado, uma leitura posterior só serve para explicar o motivo.
   */
  async function open(id: string): Promise<Election> {
    const now = clock.now();
    const [opened] = await prisma.election.updateManyAndReturn({
      where: { id, status: 'DRAFT', endsAt: { gt: now }, candidates: { some: {} } },
      data: { status: 'OPEN' },
      select: electionSelect,
    });
    if (opened) return opened;

    const current = await get(id);
    if (current.status !== 'DRAFT') throw wrongStatus(current.status, 'DRAFT');
    if (current.endsAt <= now) throw new BusinessRuleError('Election window has already ended');
    throw new BusinessRuleError('Election needs at least one candidate to open');
  }

  /** Só depois de endsAt: um administrador não pode encerrar a votação antes da hora. */
  async function close(id: string): Promise<Election> {
    const now = clock.now();
    const [closed] = await prisma.election.updateManyAndReturn({
      where: { id, status: 'OPEN', endsAt: { lte: now } },
      data: { status: 'CLOSED' },
      select: electionSelect,
    });
    if (closed) return closed;

    const current = await get(id);
    if (current.status !== 'OPEN') throw wrongStatus(current.status, 'OPEN');
    throw new BusinessRuleError('Election can only be closed after endsAt');
  }

  return { create, get, open, close };
}

export type ElectionService = ReturnType<typeof createElectionService>;
