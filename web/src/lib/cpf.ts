/** CPFs válidos (dígitos verificadores corretos) para testes. Não são de ninguém. */
function checkDigit(digits: number[]): number {
  const sum = digits.reduce((acc, d, i) => acc + d * (digits.length + 1 - i), 0);
  const rest = (sum * 10) % 11;
  return rest === 10 ? 0 : rest;
}

export function randomCpf(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const base = Array.from(bytes, (b) => b % 10);
  if (base.every((d) => d === base[0])) return randomCpf();
  const full = [...base, checkDigit(base)];
  full.push(checkDigit(full));
  const s = full.join('');
  return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9)}`;
}

/** Máscara de digitação: 52998224725 -> 529.982.247-25 */
export function formatCpf(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
}
