import { BusinessRuleError } from '../../../shared/errors/app-error.js';

export type ElectionStatus = 'DRAFT' | 'OPEN' | 'CLOSED' | 'TALLIED';

export interface Election {
  id: string;
  name: string;
  status: ElectionStatus;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
}

export interface Schedule {
  startsAt: Date;
  endsAt: Date;
}

export const MAX_ELECTION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/** Única sequência válida. Espelhada no trigger `elections_guard`. */
const NEXT_STATUS: Record<ElectionStatus, ElectionStatus | undefined> = {
  DRAFT: 'OPEN',
  OPEN: 'CLOSED',
  CLOSED: 'TALLIED',
  TALLIED: undefined,
};

export function canTransition(from: ElectionStatus, to: ElectionStatus): boolean {
  return NEXT_STATUS[from] === to;
}

export function validateNewSchedule({ startsAt, endsAt }: Schedule, now: Date): void {
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new BusinessRuleError('endsAt must be after startsAt');
  }
  if (startsAt.getTime() < now.getTime()) {
    throw new BusinessRuleError('startsAt must not be in the past');
  }
  if (endsAt.getTime() - startsAt.getTime() > MAX_ELECTION_DURATION_MS) {
    throw new BusinessRuleError('Election cannot last more than 30 days');
  }
}
