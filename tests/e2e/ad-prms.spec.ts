import { expect, test } from '@playwright/test';

async function signInAs(page: import('@playwright/test').Page, username: string) {
  await page.goto('/');
  await expect(page.getByText('TRAINING MODE — SYNTHETIC DATA — NOT PRODUCTION')).toBeVisible();

  const row = page.locator('tr', { hasText: username });
  await row.getByRole('button', { name: /Use Credentials/i }).click();
  await page.getByRole('button', { name: /Sign In to Training Session/i }).click();
  await expect(page.getByRole('banner')).toBeVisible();
}

test.describe('AD-PRMS End-to-End Governance, Isolation & UI Flows', () => {
  test('Login branding, Daylight/Dark theme toggle, bilingual Amharic switch, and validation', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    await expect(page.getByText('TRAINING MODE — SYNTHETIC DATA — NOT PRODUCTION')).toBeVisible();
    await expect(
      page.getByText('Training authentication only — not production authentication.')
    ).toBeVisible();

    // Custom emblem & architectural hero artwork render visibly
    await expect(
      page.getByRole('img', { name: /AD-PRMS architectural monogram emblem/i })
    ).toBeVisible();
    await expect(
      page.getByRole('img', { name: /Contemporary glass and stone commercial building in Addis Ababa/i })
    ).toBeVisible();

    // Theme toggle adds .dark class to <html>
    await page.getByLabel('Toggle daylight or dark slate theme').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByLabel('Toggle daylight or dark slate theme').click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    // Invalid password validation
    await page.locator('#training-password').fill('INVALID-PASSWORD');
    await page.getByRole('button', { name: /Sign In to Training Session/i }).click();
    await expect(page.getByRole('alert')).toBeVisible();

    // Switch language to Amharic and back to English
    await page.getByRole('button', { name: /አማርኛ/i }).click();
    await expect(page.getByRole('button', { name: /ወደ ስልጠና ክፍለ-ጊዜ ግባ/i })).toBeVisible();
    await page.getByRole('button', { name: /Switch to English/i }).click();

    expect(pageErrors).toEqual([]);
  });

  test('Owner isolation across Compliance Source & Evidence Review (Alpha vs Beta)', async ({
    page,
  }) => {
    await signInAs(page, 'gm.demo');

    // Open Compliance Readiness
    await page.getByRole('button', { name: 'Compliance Readiness', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Compliance Readiness/i })).toBeVisible();

    // Switch to Source & Evidence tab
    await page.getByRole('button', { name: /Source & Evidence/i }).click();
    await expect(
      page.getByText('Showing research references for: Test Owner Alpha')
    ).toBeVisible();

    // Switch owner context to Test Owner Beta
    await page.getByLabel('Owner Context').selectOption('OWN-BETA');
    await expect(
      page.getByText('Showing research references for: Test Owner Beta')
    ).toBeVisible();
  });

  test('Maker-Checker self-approval block for Finance Officer & System Admin SoD guard', async ({
    page,
  }) => {
    // 1. Finance Officer cannot self-approve own draft (REQ-SYNTH-2026-002 submitted by USR-SYNTH-03)
    await signInAs(page, 'finance.demo');
    await page.getByRole('button', { name: /Governance & Controls/i }).click();
    await page.getByRole('button', { name: /Approvals Centre/i }).click();
    await page.getByRole('button', { name: /Submitted by Me \(Self-Approval Blocked\)/i }).click();

    const aprRow = page.locator('tr', { hasText: 'REQ-SYNTH-2026-002' });
    await expect(aprRow).toBeVisible();
    await aprRow.getByRole('button', { name: /Open Detail/i }).click();

    await expect(
      page.getByText(/Self-approval is prohibited/i).first()
    ).toBeVisible();

    // Close drawer and sign out cleanly
    await page.getByLabel('Close detail drawer').click();
    await page.getByRole('button', { name: /Finance Officer/i }).first().click();
    await page.getByRole('button', { name: /Sign Out to Training Login/i }).click();

    // 2. System Administrator cannot access Finance & Tax / Collections modules
    await signInAs(page, 'sysadmin.demo');
    await page.getByRole('button', { name: /Finance & Tax/i }).click();
    const collectionsNav = page.getByRole('button', { name: /Rent & Collections/i });
    await expect(collectionsNav).toBeDisabled();
  });

  test('Tax Configuration permanently locks Active stage & Visual QA verifies zero DOM clipping', async ({
    page,
  }) => {
    await signInAs(page, 'finance.demo');

    await page.getByRole('button', { name: 'Tax Configuration', exact: true }).click();
    await expect(page.getByText(/Active.*Disabled/i).first()).toBeVisible();

    // Open Visual QA and run automated DOM Overflow Check in English
    await page.getByRole('button', { name: /Training & Reference/i }).click();
    await page.getByRole('button', { name: /Amharic & Date Visual QA/i }).click();
    await page.getByRole('button', { name: /Run DOM Overflow Check/i }).click();
    await expect(
      page.getByText(/Zero button or badge horizontal clipping detected/i)
    ).toBeVisible();
  });

  test('Mobile PWA viewport (390x844): manifest, zero horizontal overflow, Tenant & Owner Mobile modes', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    // Web App Manifest link is attached in built preview
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).toBeTruthy();

    // Launch Tenant Self-Service Mobile Mode
    await page.getByRole('button', { name: /Open Tenant Mobile/i }).first().click();
    await expect(page.getByTestId('tenant-mobile-app')).toBeVisible();

    // Verify zero horizontal overflow & sticky chrome <= 15% of 844px viewport
    const tenantLayoutMetrics = await page.evaluate(() => {
      const header = document.querySelector('header');
      const nav = document.querySelector('nav');
      const stickyHeight =
        (header ? header.getBoundingClientRect().height : 0) +
        (nav ? nav.getBoundingClientRect().height : 0);
      return {
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
        stickyRatio: stickyHeight / window.innerHeight,
      };
    });
    expect(tenantLayoutMetrics.overflowX).toBe(false);
    expect(tenantLayoutMetrics.stickyRatio).toBeLessThanOrEqual(0.15);

    // Sign out of Tenant Mobile and verify Owner Out-of-Office Mobile Mode
    await page.getByRole('button', { name: 'Sign out tenant' }).click();
    const gmRow = page.locator('tr', { hasText: 'gm.demo' });
    await gmRow.getByRole('button', { name: /Use Credentials/i }).click();
    await page.getByRole('button', { name: /Sign In to Training Session/i }).click();

    await page.getByRole('button', { name: /Switch to Out-of-Office Mobile/i }).click();
    await expect(page.getByTestId('owner-mobile-app')).toBeVisible();

    const ownerLayoutMetrics = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    }));
    expect(ownerLayoutMetrics.overflowX).toBe(false);

    // Open More tab -> All 22 Platform Modules
    await page.getByRole('button', { name: /^More$/i }).click();
    await expect(page.getByText(/All 22 Platform Modules/i)).toBeVisible();
  });
});

