import { expect, test, type Page } from '@playwright/test';

const WEEK = '2026-W39';

// Accessible names include the option text, so match the label prefix.
const callerSelect = (page: Page) => page.getByRole('combobox', { name: /^Caller/ });
const groupSelect = (page: Page) => page.getByRole('combobox', { name: /^Group/ });

async function load(page: Page, caller: string, group: string): Promise<void> {
  await page.goto('/');
  const option = callerSelect(page).locator('option', { hasText: caller });
  await callerSelect(page).selectOption({ label: (await option.textContent()) ?? '' });
  await groupSelect(page).selectOption({ label: group });
  await page.getByRole('combobox', { name: /^Week/ }).selectOption({ label: WEEK });
  await page.getByRole('button', { name: 'Load' }).click();
}

function usageTable(page: Page) {
  return page
    .getByRole('table')
    .filter({ has: page.getByRole('columnheader', { name: 'Platform' }) });
}

function connectorRow(page: Page) {
  return page.getByRole('row').filter({ hasText: 'usage-connector' });
}

/** Re-enables usage-connector through the real endpoint, so the server still authorises it. */
async function restoreConnector(page: Page, callerName: string, group: string): Promise<void> {
  await page.goto('/');
  const value = await page
    .getByLabel('Caller')
    .locator('option', { hasText: callerName })
    .getAttribute('value');
  expect(value).not.toBeNull();
  const response = await page.request.post('/capability', {
    form: {
      caller: value ?? '',
      group,
      capability: 'usage-connector',
      enabled: 'true',
      week: WEEK,
    },
  });
  expect(response.ok()).toBe(true);
}

test.describe('team lead authorization (staging)', () => {
  test('Priya sees her own group and is denied Finance by the server', async ({ page }) => {
    await load(page, 'Priya Nair', 'Clinical Operations');
    await expect(
      page.getByRole('heading', { name: 'Usage and cost by platform and week' }),
    ).toBeVisible();
    await expect(
      usageTable(page)
        .getByRole('row', { name: new RegExp(WEEK) })
        .first(),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: `Top users, ${WEEK}` })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'clinical-operations' }).first()).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('group_not_permitted')).toHaveCount(0);

    await groupSelect(page).selectOption({ label: 'Finance' });
    await page.getByRole('button', { name: 'Load' }).click();

    await expect(page.getByRole('alert').first()).toContainText('group_not_permitted');
    await expect(usageTable(page)).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'finance', exact: true })).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'clinical-operations' })).toHaveCount(0);
  });
});

test.describe('capability disable and recovery (staging)', () => {
  test.beforeEach(async ({ page }) => {
    await restoreConnector(page, 'Priya Nair', 'clinical-operations');
  });
  // Runs even when an assertion fails, so staging state is never left disabled.
  test.afterEach(async ({ page }) => {
    await restoreConnector(page, 'Priya Nair', 'clinical-operations');
  });

  test('disabling usage-connector hides data and the recovery action restores it', async ({
    page,
  }) => {
    await load(page, 'Priya Nair', 'Clinical Operations');
    await expect(
      usageTable(page)
        .getByRole('row', { name: new RegExp(WEEK) })
        .first(),
    ).toBeVisible();
    await expect(connectorRow(page)).toContainText('enabled');

    await connectorRow(page).getByRole('button', { name: 'Disable' }).click();
    await expect(page.getByRole('status')).toContainText(
      'usage-connector for clinical-operations is now disabled',
    );
    await page.getByRole('button', { name: 'Load' }).click();

    await expect(page.getByRole('alert').first()).toContainText('capability_disabled');
    await expect(usageTable(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: `Top users, ${WEEK}` })).toBeVisible();
    await expect(
      page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Name' }) }),
    ).toHaveCount(0);
    await expect(connectorRow(page)).toContainText('unknown');
    await expect(connectorRow(page).getByRole('button', { name: 'Enable' })).toBeVisible();
    await expect(connectorRow(page).getByRole('button', { name: 'Disable' })).toBeVisible();

    await connectorRow(page).getByRole('button', { name: 'Enable' }).click();
    await expect(page.getByRole('status')).toContainText(
      'usage-connector for clinical-operations is now enabled',
    );
    await page.getByRole('button', { name: 'Load' }).click();

    await expect(
      usageTable(page)
        .getByRole('row', { name: new RegExp(WEEK) })
        .first(),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(connectorRow(page)).toContainText('enabled');
    await expect(connectorRow(page).getByRole('button', { name: 'Disable' })).toBeVisible();
  });
});

test.describe('platform admin (staging)', () => {
  test('Chloe loads Finance and another foreign group', async ({ page }) => {
    for (const [name, id] of [
      ['Finance', 'finance'],
      ['Regulatory Affairs', 'regulatory-affairs'],
    ] as const) {
      await load(page, 'Chloe Dubois', name);
      await expect(usageTable(page)).toBeVisible();
      await expect(page.getByRole('cell', { name: id, exact: true }).first()).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
  });
});
