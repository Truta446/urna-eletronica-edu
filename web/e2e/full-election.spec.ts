import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Uma eleição CIFRADA inteira pela interface, com administração, mesário e urna em abas
 * diferentes do mesmo navegador (a urna é liberada pelo "cabo" BroadcastChannel).
 */
const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const devTokens = [...env.matchAll(/é: (\S+)/g)].map((m) => m[1] ?? '');
const [ADMIN_TOKEN = '', POLL_WORKER_TOKEN = ''] = devTokens;

async function signIn(page: Page, token: string) {
  await page.getByLabel('Token').fill(token);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

async function vote(booth: Page, keys: string[]) {
  await expect(booth.getByText('SEU VOTO PARA')).toBeVisible();
  for (const key of keys) await booth.getByRole('button', { name: key, exact: true }).click();
  await booth.getByRole('button', { name: 'CONFIRMA' }).click();
  await expect(booth.getByText('FIM', { exact: true })).toBeVisible();
  await expect(booth.getByText('Urna bloqueada.', { exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

const NAME = `E2E ${Date.now()}`;

test('an encrypted election from setup to verified bulletin', async ({ context }) => {
  const admin = await context.newPage();
  await admin.goto('/administracao');
  await signIn(admin, ADMIN_TOKEN);

  await admin.getByRole('button', { name: 'Nova eleição' }).click();
  await admin.getByLabel('Nome').fill(NAME);
  await admin.getByLabel('Duração').selectOption('30');
  await admin.getByRole('button', { name: 'Criar eleição' }).click();
  await expect(
    admin.getByRole('heading', { name: 'Guarde as partes da chave agora' }),
  ).toBeVisible();

  for (const [number, candidate] of [
    ['13', 'Ana'],
    ['45', 'Bruno'],
  ] as const) {
    await admin.getByLabel('Número').fill(number);
    await admin.getByLabel('Nome do candidato').fill(candidate);
    await admin.getByRole('button', { name: 'Cadastrar candidato' }).click();
    await expect(admin.getByRole('cell', { name: candidate })).toBeVisible();
  }
  await admin.getByRole('button', { name: 'Cadastrar 5 eleitores de teste' }).click();
  const cpfs = admin.locator('.notice ul li');
  await expect(cpfs).toHaveCount(5);
  const voters = await cpfs.allTextContents();
  await admin.getByRole('button', { name: 'Abrir a eleição' }).click();
  await expect(admin.getByText('Aberta.')).toBeVisible();

  const booth = await context.newPage();
  await booth.goto('/urna');
  await expect(booth.getByText('Urna bloqueada.', { exact: true })).toBeVisible();

  const poll = await context.newPage();
  await poll.goto('/mesario');
  await signIn(poll, POLL_WORKER_TOKEN);
  // Pode haver outras eleições abertas no banco de dev: escolhe a deste teste.
  const electionSelect = poll.getByLabel('Eleição');
  if (await electionSelect.isVisible()) await electionSelect.selectOption({ label: NAME });
  await expect(poll.getByText('Aguardando o próximo eleitor.')).toBeVisible({ timeout: 15_000 });

  const ballots = [['1', '3'], ['1', '3'], ['4', '5'], ['BRANCO'], ['9', '9']];
  for (const [i, keys] of ballots.entries()) {
    await poll.getByLabel('CPF do eleitor').fill(voters[i] ?? '');
    await poll.getByRole('button', { name: 'Liberar a urna' }).click();
    await expect(poll.getByText('A urna recebeu a liberação.')).toBeVisible();
    await vote(booth, keys);
  }

  // O mesmo eleitor não é habilitado duas vezes.
  await poll.getByLabel('CPF do eleitor').fill(voters[0] ?? '');
  await poll.getByRole('button', { name: 'Liberar a urna' }).click();
  await expect(poll.getByText(/não é permitida no estado atual/)).toBeVisible();

  // Encerrar só fica disponível depois do horário de término.
  const closeButton = admin.getByRole('button', { name: 'Encerrar e lacrar a urna' });
  await expect(closeButton).toBeEnabled({ timeout: 45_000 });
  await closeButton.click();
  await expect(admin.getByText(/Urna lacrada com 5 votos/)).toBeVisible();

  await admin.getByRole('button', { name: 'Preencher com as partes desta aba' }).click();
  await admin.getByRole('button', { name: 'Apurar' }).click();
  await expect(admin.getByRole('heading', { name: 'BOLETIM DE URNA' })).toBeVisible();

  const bulletin = admin.getByRole('article', { name: 'Boletim de urna' });
  await expect(bulletin).toContainText('13 Ana');
  await expect(bulletin.locator('.receipt__row', { hasText: '13 Ana' })).toContainText('2');
  await expect(bulletin.locator('.receipt__row', { hasText: '45 Bruno' })).toContainText('1');
  await expect(bulletin.locator('.receipt__row', { hasText: 'Brancos' })).toContainText('1');
  await expect(bulletin.locator('.receipt__row', { hasText: 'Nulos' })).toContainText('1');

  await admin.getByRole('button', { name: 'Verificar este resultado no navegador' }).click();
  await expect(admin.getByText('RESULTADO CONFERIDO')).toBeVisible();
  await expect(admin.getByText('[FALHOU]')).toHaveCount(0);
});
