import { z } from 'zod';

/** Nome exibível: sem caracteres de controle (evita quebra de linha/injeção em logs e relatórios). */
export const displayName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}]*$/u, 'Must not contain control characters');

/** Data ISO 8601 com fuso explícito. "2026-11-01T08:00:00" (sem fuso) é ambíguo e rejeitado. */
export const isoDateTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const electionIdParams = z.strictObject({ id: z.uuid() });
