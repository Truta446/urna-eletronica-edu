/**
 * CPF como identificador do eleitor. Num sistema real seria o título de eleitor; o CPF foi
 * escolhido por ter dígitos verificadores conhecidos, o que permite testar validação de entrada.
 */

const CPF_FORMAT = /^(\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})$/;

function checkDigit(digits: readonly number[]): number {
  const weightStart = digits.length + 1;
  const sum = digits.reduce((acc, digit, index) => acc + digit * (weightStart - index), 0);
  const rest = (sum * 10) % 11;
  return rest === 10 ? 0 : rest;
}

/** Aceita "529.982.247-25" ou "52998224725". Retorna só dígitos, ou undefined se inválido. */
export function normalizeCpf(input: string): string | undefined {
  if (!CPF_FORMAT.test(input)) return undefined;

  const digitsOnly = input.replace(/\D/g, '');
  // CPFs com todos os dígitos iguais passam no cálculo, mas não são válidos.
  if (/^(\d)\1{10}$/.test(digitsOnly)) return undefined;

  // Seguro: o regex acima garante só dígitos ASCII.
  const digits = Array.from(digitsOnly, Number);
  const first = checkDigit(digits.slice(0, 9));
  const second = checkDigit(digits.slice(0, 10));
  return digits[9] === first && digits[10] === second ? digitsOnly : undefined;
}
