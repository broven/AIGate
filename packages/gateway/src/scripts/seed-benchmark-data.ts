import '../db/migrate'
import { db, schema } from '../db'

const providers = [
  {
    id: 'mock-openai',
    type: 'openai-compatible' as const,
    apiFormat: 'openai' as const,
    endpoint: 'https://api.openai.com/v1',
    apiKey: 'sk-mock-openai',
    costMultiplier: 1.0,
    syncEnabled: false,
    syncIntervalMinutes: 60,
  },
  {
    id: 'mock-anthropic',
    type: 'openai-compatible' as const,
    apiFormat: 'claude' as const,
    endpoint: 'https://api.anthropic.com/v1',
    apiKey: 'sk-mock-anthropic',
    costMultiplier: 1.0,
    syncEnabled: false,
    syncIntervalMinutes: 60,
  },
  {
    id: 'mock-google',
    type: 'openai-compatible' as const,
    apiFormat: 'gemini' as const,
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'sk-mock-google',
    costMultiplier: 0.9,
    syncEnabled: false,
    syncIntervalMinutes: 60,
  },
  {
    id: 'mock-newapi',
    type: 'newapi' as const,
    apiFormat: 'openai' as const,
    endpoint: 'https://newapi.example.com',
    apiKey: 'sk-mock-newapi',
    costMultiplier: 0.5,
    syncEnabled: false,
    syncIntervalMinutes: 60,
  },
]

const deployments = [
  { canonical: 'gpt-4o', providerId: 'mock-openai', priceInput: 2.5, priceOutput: 10.0 },
  { canonical: 'gpt-4o', providerId: 'mock-anthropic', priceInput: 3.0, priceOutput: 12.0 },
  { canonical: 'gpt-4o-mini', providerId: 'mock-openai', priceInput: 0.15, priceOutput: 0.6 },
  { canonical: 'gpt-4o-mini', providerId: 'mock-google', priceInput: 0.18, priceOutput: 0.72 },
  { canonical: 'claude-3-5-sonnet', providerId: 'mock-anthropic', priceInput: 3.0, priceOutput: 15.0 },
  { canonical: 'claude-3-5-sonnet', providerId: 'mock-openai', priceInput: 3.5, priceOutput: 17.5 },
  { canonical: 'claude-sonnet-4', providerId: 'mock-anthropic', priceInput: 3.0, priceOutput: 15.0 },
  { canonical: 'gemini-2-5-pro', providerId: 'mock-google', priceInput: 1.25, priceOutput: 10.0 },
  { canonical: 'gemini-2-5-pro', providerId: 'mock-openai', priceInput: 1.5, priceOutput: 12.0 },
  { canonical: 'gemini-2-5-flash', providerId: 'mock-google', priceInput: 0.15, priceOutput: 0.6 },
  { canonical: 'deepseek-chat', providerId: 'mock-openai', priceInput: 0.27, priceOutput: 1.1 },
  { canonical: 'deepseek-r1', providerId: 'mock-anthropic', priceInput: 0.55, priceOutput: 2.19 },
  // NewAPI grouped deployments
  { canonical: 'gpt-4o', providerId: 'mock-newapi', groupName: 'US-Forward', priceInput: 2.0, priceOutput: 8.0 },
  { canonical: 'claude-sonnet-4', providerId: 'mock-newapi', groupName: 'US-Forward', priceInput: 2.5, priceOutput: 12.0 },
  { canonical: 'gpt-4o', providerId: 'mock-newapi', groupName: 'CN-Forward', priceInput: 3.0, priceOutput: 12.0 },
  { canonical: 'deepseek-chat', providerId: 'mock-newapi', groupName: 'CN-Forward', priceInput: 0.14, priceOutput: 0.28 },
  { canonical: 'deepseek-r1', providerId: 'mock-newapi', groupName: 'CN-Forward', priceInput: 0.55, priceOutput: 2.19 },
  { canonical: 'gemini-2-5-pro', providerId: 'mock-newapi', groupName: 'Google-Direct', priceInput: 1.25, priceOutput: 10.0 },
]

async function seed() {
  console.log('Seeding benchmark data...\n')

  // Upsert providers
  for (const p of providers) {
    await db
      .insert(schema.providers)
      .values(p)
      .onConflictDoUpdate({
        target: schema.providers.id,
        set: {
          type: p.type,
          apiFormat: p.apiFormat,
          endpoint: p.endpoint,
          apiKey: p.apiKey,
          costMultiplier: p.costMultiplier,
          syncEnabled: p.syncEnabled,
          syncIntervalMinutes: p.syncIntervalMinutes,
        },
      })
  }
  console.log(`Providers: ${providers.length} upserted`)

  // Upsert model deployments
  for (const d of deployments) {
    const groupName = (d as { groupName?: string }).groupName ?? null
    const deploymentId = groupName
      ? `${d.providerId}-${groupName}-${d.canonical}`
      : `${d.providerId}:${d.canonical}`
    await db
      .insert(schema.modelDeployments)
      .values({
        deploymentId,
        providerId: d.providerId,
        canonical: d.canonical,
        upstream: d.canonical,
        groupName,
        priceInput: d.priceInput,
        priceOutput: d.priceOutput,
        priceSource: 'manual',
        status: 'active',
      })
      .onConflictDoUpdate({
        target: schema.modelDeployments.deploymentId,
        set: {
          providerId: d.providerId,
          canonical: d.canonical,
          upstream: d.canonical,
          groupName,
          priceInput: d.priceInput,
          priceOutput: d.priceOutput,
          priceSource: 'manual',
          status: 'active',
        },
      })
  }
  console.log(`Model deployments: ${deployments.length} upserted`)

  console.log('\nSeed complete!')
  console.log(`  ${providers.length} providers`)
  console.log(`  ${deployments.length} model deployments`)
  console.log(`  ${new Set(deployments.map((d) => d.canonical)).size} unique canonical models`)
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
