import { describe, expect, it } from 'vitest';
import { normalizeCpf } from '../../src/modules/voter/domain/cpf.js';

/** Vetores conhecidos e independentes da implementação (exemplos públicos de CPF válido). */
describe('normalizeCpf', () => {
  it.each([
    ['529.982.247-25', '52998224725'],
    ['52998224725', '52998224725'],
    ['111.444.777-35', '11144477735'],
    ['000.000.001-91', '00000000191'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeCpf(input)).toBe(expected);
  });

  it.each([
    ['wrong first check digit', '529.982.247-35'],
    ['wrong second check digit', '529.982.247-24'],
    ['all digits equal', '111.111.111-11'],
    ['all zeros', '000.000.000-00'],
    ['10 digits', '5299822472'],
    ['12 digits', '529982247250'],
    ['letters', '52998224a25'],
    ['partial formatting', '529982247-25'],
    ['spaces', ' 529.982.247-25'],
    ['unicode digits', '５２９９８２２４７２５'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    expect(normalizeCpf(input)).toBeUndefined();
  });
});
