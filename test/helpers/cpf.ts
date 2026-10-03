import { randomInt } from 'node:crypto';

function digit(base: number[]): number {
  const sum = base.reduce((acc, d, i) => acc + d * (base.length + 1 - i), 0);
  const rest = (sum * 10) % 11;
  return rest === 10 ? 0 : rest;
}

/** CPF válido aleatório, formatado (###.###.###-##). Só para gerar massa de teste. */
export function randomCpf(): string {
  let base: number[];
  do {
    base = Array.from({ length: 9 }, () => randomInt(10));
  } while (base.every((d) => d === base[0]));
  const full = [...base, digit(base)];
  full.push(digit(full));
  const s = full.join('');
  return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9)}`;
}
