/** Escolha já decodificada (em claro na v1; depois de decifrada na v2). */
export type DecodedChoice =
  { kind: 'CANDIDATE'; candidateId: string } | { kind: 'BLANK' } | { kind: 'NULL_VOTE' };

export interface CandidateRef {
  id: string;
  number: number;
  name: string;
}

export interface TallyResultData {
  candidates: { candidateId: string; number: number; name: string; votes: number }[];
  blank: number;
  null: number;
  totalBallots: number;
}

export class UnknownCandidateError extends Error {}

/**
 * Apuração como FUNÇÃO PURA: mesma entrada, mesma saída, em qualquer máquina e em qualquer
 * ordem dos votos. Não toca em banco nem em relógio; é isso que a torna reproduzível.
 * Candidatos sem voto aparecem com 0; a lista sai ordenada por número.
 */
export function tallyBallots(
  choices: readonly DecodedChoice[],
  candidates: readonly CandidateRef[],
): TallyResultData {
  const votes = new Map(candidates.map((c) => [c.id, 0]));
  let blank = 0;
  let nullVotes = 0;

  for (const choice of choices) {
    if (choice.kind === 'BLANK') blank += 1;
    else if (choice.kind === 'NULL_VOTE') nullVotes += 1;
    else {
      const current = votes.get(choice.candidateId);
      if (current === undefined) throw new UnknownCandidateError(choice.candidateId);
      votes.set(choice.candidateId, current + 1);
    }
  }

  return {
    candidates: [...candidates]
      .sort((a, b) => a.number - b.number)
      .map((c) => ({
        candidateId: c.id,
        number: c.number,
        name: c.name,
        votes: votes.get(c.id) ?? 0,
      })),
    blank,
    null: nullVotes,
    totalBallots: choices.length,
  };
}
