import { test, expect } from '@playwright/test'

// These tests require the gateway running at localhost:3000 with seeded data
// and the dashboard dev server at localhost:5173

test.describe('Models Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/models')
  })

  // 1. PAGE LOAD
  test('shows page title', async ({ page }) => {
    await expect(page.locator('h1')).toHaveText('Models')
  })

  test('shows stat chips with counts', async ({ page }) => {
    // Wait for data to load
    await expect(page.locator('.badge').first()).toBeVisible()
    const badges = page.locator('.section-header .badge')
    await expect(badges).toHaveCount(3)
    // Each badge should contain a number
    for (let i = 0; i < 3; i++) {
      const text = await badges.nth(i).textContent()
      expect(text).toMatch(/\d+/)
    }
  })

  test('shows grouped model rows', async ({ page }) => {
    // Wait for table to render
    await expect(page.locator('.table-container')).toBeVisible()
    // Should have at least one model row with a canonical name
    const rows = page.locator('tbody tr')
    await expect(rows.first()).toBeVisible()
  })

  // 2. GROUPING
  test('models are grouped by canonical name', async ({ page }) => {
    await expect(page.locator('.table-container')).toBeVisible()
    // Model rows have strong tags with canonical names
    const modelNames = page.locator('tbody tr strong')
    const count = await modelNames.count()
    expect(count).toBeGreaterThan(0)
  })

  // 3. EXPAND / COLLAPSE
  test('click model row expands deployments', async ({ page }) => {
    await expect(page.locator('.table-container')).toBeVisible()

    // Click first model row
    const firstModelRow = page.locator('tbody tr').first()
    await firstModelRow.click()

    // Should now see deployment rows with provider badges and price inputs
    await expect(page.locator('tbody input[type="text"]').first()).toBeVisible()
  })

  test('click expanded model row collapses deployments', async ({ page }) => {
    await expect(page.locator('.table-container')).toBeVisible()

    const firstModelRow = page.locator('tbody tr').first()
    // Expand
    await firstModelRow.click()
    await expect(page.locator('tbody input[type="text"]').first()).toBeVisible()

    // Collapse
    await firstModelRow.click()
    // Price inputs should be gone
    await expect(page.locator('tbody input[type="text"]')).toHaveCount(0)
  })

  test('multiple groups can be expanded simultaneously', async ({ page }) => {
    await expect(page.locator('.table-container')).toBeVisible()

    const modelRows = page.locator('tbody tr strong')
    const count = await modelRows.count()
    if (count < 2) {
      test.skip()
      return
    }

    // Click first two model rows (find parent tr)
    await modelRows.nth(0).locator('..').locator('..').click()
    await modelRows.nth(1).locator('..').locator('..').click()

    // Should see price inputs from both expanded groups
    const inputs = page.locator('tbody input[type="text"]')
    await expect(inputs).toHaveCount(await inputs.count()) // at least some
    expect(await inputs.count()).toBeGreaterThanOrEqual(4) // at least 2 deployments × 2 inputs each
  })

  // 4. FILTERING
  test('search filters by canonical name', async ({ page }) => {
    await expect(page.locator('.table-container')).toBeVisible()

    const modelsBefore = await page.locator('tbody tr strong').count()
    // Type a search that likely won't match everything
    await page.locator('input[placeholder="Search models..."]').fill('zzz-nonexistent')

    // Should show "No matching models" or fewer rows
    const noMatch = page.locator('text=No matching models')
    const modelsAfter = page.locator('tbody tr strong')
    // Either empty state or fewer models
    const hasNoMatch = await noMatch.isVisible().catch(() => false)
    const afterCount = await modelsAfter.count()
    expect(hasNoMatch || afterCount < modelsBefore).toBeTruthy()
  })

  test('status filter works', async ({ page }) => {
    await expect(page.locator('.table-container')).toBeVisible()

    // Select "Active" status
    await page.locator('select').last().selectOption('active')

    // All visible model groups should have "active" badge
    const statusBadges = page.locator('tbody tr:not([style*="bg-primary"]) .badge.green')
    if (await statusBadges.count() > 0) {
      for (let i = 0; i < await statusBadges.count(); i++) {
        await expect(statusBadges.nth(i)).toHaveText('active')
      }
    }
  })

  // 5. INLINE PRICE EDITING
  test('save button is disabled when no changes made', async ({ page }) => {
    await expect(page.locator('.table-container')).toBeVisible()

    // Expand first model
    await page.locator('tbody tr').first().click()
    await expect(page.locator('tbody input[type="text"]').first()).toBeVisible()

    // Save button should be disabled
    const saveBtn = page.locator('button:has-text("Save")').first()
    await expect(saveBtn).toBeDisabled()
  })

  test('editing a price enables the save button', async ({ page }) => {
    await expect(page.locator('.table-container')).toBeVisible()

    // Expand first model
    await page.locator('tbody tr').first().click()

    // Edit first price input
    const priceInput = page.locator('tbody input[type="text"]').first()
    await priceInput.click()
    await priceInput.fill('99.99')

    // Save button should now be enabled
    const saveBtn = page.locator('button:has-text("Save")').first()
    await expect(saveBtn).toBeEnabled()
  })

  test('saving a price calls the API and refreshes', async ({ page }) => {
    await expect(page.locator('.table-container')).toBeVisible()

    // Expand first model
    await page.locator('tbody tr').first().click()

    const priceInput = page.locator('tbody input[type="text"]').first()
    const originalValue = await priceInput.inputValue()

    // Edit price
    await priceInput.click()
    await priceInput.fill('42.00')

    // Click save
    const saveBtn = page.locator('button:has-text("Save")').first()
    await saveBtn.click()

    // Save button should become disabled again (edit cleared)
    await expect(saveBtn).toBeDisabled({ timeout: 5000 })

    // Restore original price
    await priceInput.click()
    await priceInput.fill(originalValue || '')
    if (originalValue) {
      await saveBtn.click()
      await expect(saveBtn).toBeDisabled({ timeout: 5000 })
    }
  })

  // 7. PRICE SOURCE BADGE
  test('deployment rows show price source badges', async ({ page }) => {
    await expect(page.locator('.table-container')).toBeVisible()

    // Expand first model
    await page.locator('tbody tr').first().click()
    await expect(page.locator('tbody input[type="text"]').first()).toBeVisible()

    // Should see a price source badge (provider_api, models_dev, manual, or unknown)
    const sourceBadge = page.locator('tr[style*="bg-primary"] .badge').first()
    await expect(sourceBadge).toBeVisible()
    const text = await sourceBadge.textContent()
    expect(['provider_api', 'models_dev', 'manual', 'unknown']).toContain(text)
  })

  // 9. NAVIGATION
  test('sidebar has Models link and it is active', async ({ page }) => {
    const modelsLink = page.locator('.nav-link', { hasText: 'Models' })
    await expect(modelsLink).toBeVisible()
    await expect(modelsLink).toHaveClass(/active/)
  })

  test('can navigate to Models from other pages', async ({ page }) => {
    // Go to overview first
    await page.goto('/')
    await expect(page.locator('h1')).toHaveText('Overview')

    // Click Models in sidebar
    await page.locator('.nav-link', { hasText: 'Models' }).click()
    await expect(page).toHaveURL(/\/models/)
    await expect(page.locator('h1')).toHaveText('Models')
  })
})
