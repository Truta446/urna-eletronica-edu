import type { PrismaClient } from '../../../database/client.js';
import { isUniqueViolation } from '../../../database/errors.js';
import { ConflictError, NotFoundError } from '../../../shared/errors/app-error.js';
import type { Candidate } from '../domain/candidate.js';

export interface CreateCandidateInput {
  number: number;
  name: string;
}

const candidateSelect = { id: true, electionId: true, number: true, name: true } as const;

export function createCandidateService({ prisma }: { prisma: PrismaClient }) {
  async function requireElectionStatus(electionId: string) {
    const election = await prisma.election.findUnique({
      where: { id: electionId },
      select: { status: true },
    });
    if (!election) throw new NotFoundError('Election');
    return election.status;
  }

  /**
   * A checagem de DRAFT aqui dá uma mensagem clara; a garantia real é o trigger
   * `candidates_guard`, que serializa com uma abertura concorrente (SELECT ... FOR SHARE).
   */
  async function create(electionId: string, input: CreateCandidateInput): Promise<Candidate> {
    const status = await requireElectionStatus(electionId);
    if (status !== 'DRAFT') {
      throw new ConflictError(`Election is ${status}, candidates can only be added in DRAFT`);
    }

    try {
      return await prisma.candidate.create({
        data: { electionId, ...input },
        select: candidateSelect,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'candidates_election_id_number_key')) {
        throw new ConflictError(`Candidate number ${input.number} is already taken`);
      }
      throw error;
    }
  }

  async function list(electionId: string): Promise<Candidate[]> {
    await requireElectionStatus(electionId);
    return prisma.candidate.findMany({
      where: { electionId },
      select: candidateSelect,
      orderBy: { number: 'asc' },
    });
  }

  return { create, list };
}

export type CandidateService = ReturnType<typeof createCandidateService>;
