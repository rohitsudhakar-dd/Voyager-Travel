import { expect, test } from '@playwright/test';

/**
 * The demo spine from 06-USER-FLOWS.md § 3: home, search, results, checkout,
 * payment, confirmation. Written against `data-testid` only, so it survives copy
 * changes.
 */

const TEST_CARD = '4242 4242 4242 4242';

test('a traveller books a flight end to end', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('search-tab-flights').click();

  await page.getByTestId('search-origin').fill('LHR');
  await page
    .getByRole('option', { name: /heathrow/i })
    .first()
    .click();

  await page.getByTestId('search-destination').fill('JFK');
  await page
    .getByRole('option', { name: /kennedy/i })
    .first()
    .click();

  await page.getByTestId('search-submit').click();

  await expect(page).toHaveURL(/\/results\/flights\//);
  const firstResult = page.getByTestId('flight-result-row').first();
  await expect(firstResult).toBeVisible();

  await firstResult.getByTestId('flight-result-select').click();

  await expect(page).toHaveURL(/\/checkout\/[^/]+\/review/);
  await page.getByTestId('review-continue').click();

  await expect(page).toHaveURL(/\/checkout\/[^/]+\/passengers/);
  await page.getByTestId('passenger-0-first-name').fill('Ada');
  await page.getByTestId('passenger-0-last-name').fill('Okonkwo');
  await page.getByTestId('passenger-0-dob').fill('1989-04-17');
  await page.getByTestId('passenger-0-nationality').fill('GB');
  await page.getByTestId('contact-email').fill('ada@voyager.test');
  await page.getByTestId('contact-phone').fill('+447700900123');
  await page.getByTestId('passengers-continue').click();

  await expect(page).toHaveURL(/\/checkout\/[^/]+\/payment/);
  await page.getByTestId('card-holder').fill('A Okonkwo');
  await page.getByTestId('card-number').fill(TEST_CARD);
  await expect(page.getByTestId('card-brand')).toHaveText('Solaris');
  await page.getByTestId('card-expiry').fill('11 / 30');
  await page.getByTestId('card-cvc').fill('123');
  await page.getByTestId('payment-submit').click();

  await expect(page).toHaveURL(/\/confirmation\//);
  await expect(page.getByTestId('confirmation')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('confirmation-pnr-value')).toHaveText(
    /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/,
  );
});

test('a declined card keeps the traveller on the payment step', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('search-origin').fill('LHR');
  await page
    .getByRole('option', { name: /heathrow/i })
    .first()
    .click();
  await page.getByTestId('search-destination').fill('CDG');
  await page
    .getByRole('option', { name: /gaulle/i })
    .first()
    .click();
  await page.getByTestId('search-submit').click();

  await page.getByTestId('flight-result-row').first().getByTestId('flight-result-select').click();
  await page.getByTestId('review-continue').click();

  await page.getByTestId('passenger-0-first-name').fill('Ada');
  await page.getByTestId('passenger-0-last-name').fill('Okonkwo');
  await page.getByTestId('passenger-0-dob').fill('1989-04-17');
  await page.getByTestId('passenger-0-nationality').fill('GB');
  await page.getByTestId('contact-email').fill('ada@voyager.test');
  await page.getByTestId('contact-phone').fill('+447700900123');
  await page.getByTestId('passengers-continue').click();

  await page.getByTestId('card-holder').fill('A Okonkwo');
  await page.getByTestId('card-number').fill('4000 0000 0000 9995');
  await page.getByTestId('card-expiry').fill('11 / 30');
  await page.getByTestId('card-cvc').fill('123');
  await page.getByTestId('payment-submit').click();

  await expect(page.getByTestId('payment-declined')).toBeVisible();
  await expect(page).toHaveURL(/\/checkout\/[^/]+\/payment/);

  // Resubmitting without this gesture replays the declined attempt, because the
  // idempotency key is only rotated here.
  await page.getByTestId('payment-retry').click();
  await page.getByTestId('card-number').fill('4242 4242 4242 4242');
  await page.getByTestId('payment-submit').click();
  await expect(page).toHaveURL(/\/confirmation\//);
});

test('the ops console gates on the admin secret and lists every chaos group', async ({ page }) => {
  await page.goto('/admin');

  await page.getByTestId('admin-secret').fill('local-admin-secret');
  await page.getByTestId('admin-secret-submit').click();

  await expect(page.getByTestId('chaos-flag-gds_latency_ms')).toBeVisible();
  await expect(page.getByTestId('chaos-flag-frontend_heavy_assets')).toBeVisible();

  await page.getByTestId('admin-nav-scenarios').click();
  await expect(page.getByTestId('reset-all-chaos')).toBeVisible();
  await expect(page.getByTestId('scenario-S8')).toBeVisible();
});
