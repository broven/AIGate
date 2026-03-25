import '../db/migrate'
import { db, schema } from '../db'

const keys = [
  { id: 'key-dev-001', name: 'Development', keyPlain: 'ak-dev-testkey001' },
  { id: 'key-prod-002', name: 'Production', keyPlain: 'ak-prod-testkey002' },
  { id: 'key-ci-003', name: 'CI/CD', keyPlain: 'ak-ci-testkey003' },
]

// Generate daily usage for the past 14 days
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

const usageRows = [
  // Development key — active usage
  { keyName: 'Development', model: 'gpt-4o',              days: [0,1,2,3,4,5,6], req: 12, inp: 8000,  out: 2000,  costPer: 0.028 },
  { keyName: 'Development', model: 'claude-3-5-sonnet',   days: [0,1,2,3],       req: 5,  inp: 5000,  out: 1500,  costPer: 0.022 },
  { keyName: 'Development', model: 'gpt-4o-mini',         days: [0,1,2,3,4,5],  req: 30, inp: 12000, out: 3000,  costPer: 0.002 },
  // Production key — heavier usage
  { keyName: 'Production',  model: 'gpt-4o',              days: [0,1,2,3,4,5,6,7,8,9], req: 80, inp: 50000, out: 15000, costPer: 0.175 },
  { keyName: 'Production',  model: 'gpt-4o-mini',         days: [0,1,2,3,4,5,6,7],     req: 200, inp: 80000, out: 20000, costPer: 0.015 },
  { keyName: 'Production',  model: 'claude-sonnet-4',     days: [0,1,2,3],              req: 15, inp: 10000, out: 3000,  costPer: 0.074 },
  // CI key — minimal usage
  { keyName: 'CI/CD',       model: 'gpt-4o-mini',         days: [0,2,5],                req: 8,  inp: 3000,  out: 800,   costPer: 0.001 },
]

async function seed() {
  console.log('Seeding API keys and usage data...\n')

  // Upsert gateway keys
  for (const k of keys) {
    await db
      .insert(schema.gatewayKeys)
      .values(k)
      .onConflictDoUpdate({
        target: schema.gatewayKeys.id,
        set: { name: k.name, keyPlain: k.keyPlain },
      })
  }
  console.log(`API keys: ${keys.length} upserted`)

  // Upsert daily usage
  let rowCount = 0
  for (const u of usageRows) {
    for (const dayOffset of u.days) {
      await db
        .insert(schema.dailyUsage)
        .values({
          date: daysAgo(dayOffset),
          gatewayKey: u.keyName,
          model: u.model,
          requestCount: u.req,
          totalInputTokens: u.inp,
          totalOutputTokens: u.out,
          totalCost: u.costPer,
        })
        .onConflictDoUpdate({
          target: [schema.dailyUsage.date, schema.dailyUsage.gatewayKey, schema.dailyUsage.model],
          set: {
            requestCount: u.req,
            totalInputTokens: u.inp,
            totalOutputTokens: u.out,
            totalCost: u.costPer,
          },
        })
      rowCount++
    }
  }
  console.log(`Daily usage rows: ${rowCount} upserted`)
  console.log('\nSeed complete!')
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
