export interface Candidate {
  id: string;
  electionId: string;
  number: number;
  name: string;
}

/** Números de 1 a 5 dígitos, como na urna brasileira. Espelhado em `candidates_number_check`. */
export const MIN_CANDIDATE_NUMBER = 1;
export const MAX_CANDIDATE_NUMBER = 99_999;
