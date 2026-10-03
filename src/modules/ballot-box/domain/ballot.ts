export type Choice = { type: 'candidate'; number: number } | { type: 'blank' } | { type: 'null' };

export type BallotKind = 'CANDIDATE' | 'BLANK' | 'NULL_VOTE';

export function ballotKindOf(choice: Choice): BallotKind {
  switch (choice.type) {
    case 'candidate':
      return 'CANDIDATE';
    case 'blank':
      return 'BLANK';
    case 'null':
      return 'NULL_VOTE';
  }
}

/** Representação canônica da requisição: mesma intenção, mesma string, qualquer ordem de chaves. */
export function canonicalRequest(electionId: string, choice: Choice): string {
  const choicePart = choice.type === 'candidate' ? `candidate:${choice.number}` : choice.type;
  return `${electionId}|${choicePart}`;
}

/**
 * Única resposta de sucesso. Sem id do voto e sem recibo: um recibo que identifica o voto,
 * cruzado com a lista publicada na apuração, permitiria PROVAR em quem se votou (venda de voto).
 */
export const BALLOT_ACCEPTED = { accepted: true } as const;
