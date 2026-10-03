import { z } from 'zod';

export interface OperatorCredential {
  /** Nome legível do operador (admin ou mesário); vira o `actorIdentifier` na auditoria. */
  label: string;
  /** SHA-256 do token. O token em si nunca fica em configuração. */
  tokenHash: Buffer;
}

const ENTRY_PATTERN = /^([a-z0-9][a-z0-9._-]{0,31}):([0-9a-f]{64})$/;

/**
 * Formato: `label:sha256hex,label2:sha256hex`. Gere com `npm run operator:token -- <label>`.
 */
export const operatorCredentialsSchema = z
  .string()
  .trim()
  .min(1)
  .transform((raw, ctx): OperatorCredential[] => {
    const credentials: OperatorCredential[] = [];
    for (const entry of raw.split(',').map((part) => part.trim())) {
      const match = ENTRY_PATTERN.exec(entry);
      if (!match?.[1] || !match[2]) {
        // Não incluir `entry` na mensagem: é material de credencial.
        ctx.addIssue({ code: 'custom', message: 'Each entry must be label:sha256hex' });
        return z.NEVER;
      }
      credentials.push({ label: match[1], tokenHash: Buffer.from(match[2], 'hex') });
    }

    const labels = new Set(credentials.map((c) => c.label));
    const hashes = new Set(credentials.map((c) => c.tokenHash.toString('hex')));
    if (labels.size !== credentials.length || hashes.size !== credentials.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate label or token hash' });
      return z.NEVER;
    }
    return credentials;
  });
