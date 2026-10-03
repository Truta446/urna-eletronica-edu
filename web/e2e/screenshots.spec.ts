import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * Gera as imagens do README (não roda na suíte normal).
 * Uso: SCREENSHOTS=1 npx playwright test screenshots
 */
test.skip(!process.env.SCREENSHOTS, 'só com SCREENSHOTS=1');

const OUT = '../.github/assets/screenshots';
const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const [ADMIN = '', POLL = ''] = [...env.matchAll(/é: (\S+)/g)].map((m) => m[1] ?? '');

const NAME = 'Conselho de representantes';

test('screenshots', async ({ context }) => {
  const admin = await context.newPage();
  await admin.setViewportSize({ width: 1280, height: 900 });
  await admin.goto('/');
  await admin.screenshot({ path: `${OUT}/inicio.png` });

  await admin.goto('/administracao');
  await admin.getByLabel('Token').fill(ADMIN);
  await admin.getByRole('button', { name: 'Entrar' }).click();
  await admin.getByRole('button', { name: 'Nova eleição' }).click();
  await admin.getByLabel('Nome').fill(NAME);
  await admin.getByLabel('Duração').selectOption('30');
  await admin.getByRole('button', { name: 'Criar eleição' }).click();
  for (const [n, c] of [
    ['13', 'Ana Ribeiro'],
    ['45', 'Bruno Tavares'],
    ['22', 'Carla Nunes'],
  ] as const) {
    await admin.getByLabel('Número').fill(n);
    await admin.getByLabel('Nome do candidato').fill(c);
    await admin.getByRole('button', { name: 'Cadastrar candidato' }).click();
    await expect(admin.getByRole('cell', { name: c })).toBeVisible();
  }
  await admin.getByRole('button', { name: 'Cadastrar 5 eleitores de teste' }).click();
  await expect(admin.locator('.notice ul li')).toHaveCount(5);
  const voters = await admin.locator('.notice ul li').allTextContents();
  await admin.screenshot({ path: `${OUT}/administracao.png`, fullPage: true });
  await admin.getByRole('button', { name: 'Abrir a eleição' }).click();

  const booth = await context.newPage();
  await booth.setViewportSize({ width: 1280, height: 760 });
  await booth.goto('/urna');
  await booth.screenshot({ path: `${OUT}/urna-bloqueada.png` });

  const poll = await context.newPage();
  await poll.setViewportSize({ width: 1100, height: 760 });
  await poll.goto('/mesario');
  await poll.getByLabel('Token').fill(POLL);
  await poll.getByRole('button', { name: 'Entrar' }).click();
  // Pode haver outras eleições abertas no banco de dev: escolhe a deste teste.
  const electionSelect = poll.getByLabel('Eleição');
  if (await electionSelect.isVisible()) await electionSelect.selectOption({ label: NAME });
  await expect(poll.getByText('Aguardando o próximo eleitor.')).toBeVisible({ timeout: 15_000 });

  const choices = [['1', '3'], ['4', '5'], ['1', '3'], ['2', '2'], ['BRANCO']];
  for (const [i, keys] of choices.entries()) {
    await poll.getByLabel('CPF do eleitor').fill(voters[i] ?? '');
    await poll.getByRole('button', { name: 'Liberar a urna' }).click();
    await expect(poll.getByText('A urna recebeu a liberação.')).toBeVisible();
    if (i === 0) await poll.screenshot({ path: `${OUT}/mesario.png` });
    for (const key of keys) await booth.getByRole('button', { name: key, exact: true }).click();
    if (i === 0) await booth.screenshot({ path: `${OUT}/urna-votando.png` });
    await booth.getByRole('button', { name: 'CONFIRMA' }).click();
    await expect(booth.getByText('Urna bloqueada.', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
  }

  await expect(admin.getByRole('button', { name: 'Encerrar e lacrar a urna' })).toBeEnabled({
    timeout: 45_000,
  });
  await admin.getByRole('button', { name: 'Encerrar e lacrar a urna' }).click();
  await admin.getByRole('button', { name: 'Preencher com as partes desta aba' }).click();
  await admin.getByRole('button', { name: 'Apurar' }).click();
  await admin.getByRole('button', { name: 'Verificar este resultado no navegador' }).click();
  await expect(admin.getByText('RESULTADO CONFERIDO')).toBeVisible();
  await admin.screenshot({ path: `${OUT}/boletim.png`, fullPage: true });

  await booth.setViewportSize({ width: 390, height: 844 });
  await booth.screenshot({ path: `${OUT}/urna-celular.png`, fullPage: true });
});
