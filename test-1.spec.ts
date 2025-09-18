import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://docs.google.com/spreadsheets/d/1pAcZtOQy07ZwdmfmDtjgzhR2dSl_3Xmlabmfstaza7w/edit?gid=1879337348#gid=1879337348');
  await page.waitForLoadState('load');
  // await page.locator('[id$="-fixed"] > div[class="overlay-container-ltr"]').click();
  await page.locator('[id$="-fixed"] div[class*="overlay"]').first().click();
});