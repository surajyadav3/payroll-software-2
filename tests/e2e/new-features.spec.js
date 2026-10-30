// Smoke E2E for the 2026-10 features: Work (tasks), Help, notification
// channels, Performance, recruitment pipeline + careers settings.
// Needs an HR/admin login of a test tenant:
//   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD  (never commit credentials)
// Creates one "[E2E]" task assigned to the signed-in user and deletes it again.
import { test, expect } from 'playwright/test';

const EMAIL = process.env.E2E_ADMIN_EMAIL;
const PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('New features smoke', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD not set');

  let pageErrors;

  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('dialog', (d) => d.accept());
    await page.goto('/login');
    await page.getByPlaceholder('you@company.com or 10-digit phone').fill(EMAIL);
    await page.getByPlaceholder('••••••••').fill(PASSWORD);
    await page.getByRole('button', { name: /log in|sign in/i }).click();
    await expect(page).toHaveURL(/dashboard|home|outlets/, { timeout: 20000 });
  });

  test.afterEach(() => {
    expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  });

  test('work: add a task, comment on it, delete it', async ({ page }) => {
    const title = `[E2E] smoke task ${Date.now()}`;
    // The old /tasks address still works: it lands on My Work.
    await page.goto('/tasks');
    await expect(page).toHaveURL(/\/work\/me/);
    await page.goto('/work');
    await expect(page.getByRole('heading', { name: /^Tasks/ })).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'New task' }).click();
    await page.getByPlaceholder('What needs doing?').fill(title);
    await page.getByRole('button', { name: 'Add task' }).click();
    await expect(page.getByText(/ added\.$/)).toBeVisible();

    // A new task opens in its drawer.
    await expect(page.getByRole('dialog').getByText(title).first()).toBeVisible();
    await page.getByPlaceholder('Comment — @ to mention someone').fill('E2E comment');
    await page.keyboard.press('Enter');
    await expect(page.getByText('E2E comment')).toBeVisible();

    await page.getByRole('button', { name: 'Delete task' }).click();
    await expect(page.getByText(/ deleted$/)).toBeVisible();
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  });

  test('help: search and open an answer', async ({ page }) => {
    await page.goto('/help');
    await expect(page.getByRole('heading', { name: /help & faq/i })).toBeVisible();
    await page.getByPlaceholder(/search help/i).fill('leave balance');
    await page.getByRole('button', { name: /check my leave balance/i }).click();
    await expect(page.getByRole('button', { name: /open this page/i })).toBeVisible();
  });

  test('settings: task notification channels card', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('Task Notifications & Reminders')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Daily reminders (9:00 AM)')).toBeVisible();
  });

  test('performance loads', async ({ page }) => {
    await page.goto('/performance');
    await expect(page.getByRole('heading', { name: 'Performance', exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('tab', { name: 'Review cycles' })).toBeVisible();
    await page.getByRole('tab', { name: 'KPIs' }).click();
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  });

  test('recruitment: all candidates + add candidate form + careers settings', async ({ page }) => {
    await page.goto('/recruitment-pipeline');
    await page.getByRole('button', { name: /all candidates/i }).click();
    await expect(page.getByRole('columnheader', { name: 'Source' })).toBeVisible();
    await page.getByRole('button', { name: /add candidate/i }).first().click();
    await expect(page.getByText('Job posting *')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.goto('/hiring');
    await expect(page.getByText('Public Careers Page')).toBeVisible();
  });
});
