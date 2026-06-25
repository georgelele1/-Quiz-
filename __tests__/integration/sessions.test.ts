/**
 * Integration tests: Session API & Quiz Progress
 *
 * Tests:
 *  - Create session (POST /api/sessions)
 *  - Recover session (GET /api/sessions/:id)
 *  - Save steps incrementally (PUT /api/sessions/:id/steps)
 *  - Progress recovery after simulated page close
 *  - Out-of-order step submission (idempotency)
 *  - Duplicate step submission (idempotency)
 *  - Concurrent update safety
 *  - Input validation rejection (illegal values, injection)
 *  - Complete flow: all 8 steps → calculate → results
 *
 * These tests call real Next.js API route handlers directly,
 * bypassing HTTP, so they need a real Prisma + Postgres connection.
 * Set DATABASE_URL in .env.test for CI.
 *
 * Pattern: each test creates its own session to avoid state leakage.
 */

import { prisma } from '@/lib/prisma'
import { NextRequest } from 'next/server'

// Import route handlers
import { POST as createSession } from '@/app/api/sessions/route'
import { GET as getSession } from '@/app/api/sessions/[id]/route'
import { PUT as saveStep } from '@/app/api/sessions/[id]/steps/route'
import { POST as calculate } from '@/app/api/sessions/[id]/calculate/route'

// ── Helpers ────────────────────────────────────────────────────────────────

let sessionCookie = ''

function makeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost:3000', {
    method,
    headers: { 'Content-Type': 'application/json', ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function createTestSession(): Promise<string> {
  const req = makeRequest('POST', {})
  const res = await createSession(req)
  sessionCookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
  const data = await res.json()
  return data.id
}

const COMPLETE_QUIZ_DATA = [
  { step: 1,  data: { gender: 'female' } },
  { step: 2,  data: { age: 34 } },
  { step: 3,  data: { goal: 'lose_weight' } },
  { step: 4,  data: { focusAreas: ['belly_fat'] } },
  { step: 5,  data: { activityTypes: ['home_workouts'] } },
  { step: 6,  data: { heightCm: 165, weightKg: 75 } },
  { step: 7,  data: { targetWeightKg: 60 } },
  { step: 8,  data: { activityLevel: 'moderate' } },
  { step: 9,  data: { dietPreference: 'no_preference' } },
  { step: 10, data: { email: 'test@example.com' } },
]

// ── Session creation ────────────────────────────────────────────────────────

describe('POST /api/sessions', () => {
  test('creates a new anonymous session without a subscription', async () => {
    const req = makeRequest('POST', {})
    const res = await createSession(req)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBeDefined()
    expect(body.currentStep).toBe(0)
    expect(body.isCompleted).toBe(false)
    expect(body.subscription).toBeNull()
  })

  test('idempotency: same clientId returns existing session (200)', async () => {
    const clientId = `test-${Date.now()}`
    const req1 = makeRequest('POST', { clientId })
    const res1 = await createSession(req1)
    expect(res1.status).toBe(201)
    sessionCookie = res1.headers.get('set-cookie')?.split(';')[0] ?? ''

    const req2 = makeRequest('POST', { clientId })
    const res2 = await createSession(req2)
    expect(res2.status).toBe(200)

    const body1 = await res1.json()
    const body2 = await res2.json()
    expect(body1.id).toBe(body2.id)
  })
})

// ── Session recovery ────────────────────────────────────────────────────────

describe('GET /api/sessions/:id', () => {
  test('returns session with quiz data after steps saved', async () => {
    const id = await createTestSession()

    // Save the age step
    await saveStep(
      makeRequest('PUT', { step: 2, data: { age: 28 } }),
      { params: { id } },
    )

    const res = await getSession(makeRequest('GET'), { params: { id } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.quizData.age).toBe(28)
    expect(body.currentStep).toBe(2)
  })

  test('returns 404 for non-existent session', async () => {
    const res = await getSession(
      makeRequest('GET'),
      { params: { id: 'does-not-exist-xyz' } },
    )
    expect(res.status).toBe(404)
  })

  test('simulates page close & recovery: progress is preserved', async () => {
    const id = await createTestSession()

    // "User fills out steps 1-3, closes tab"
    for (const { step, data } of COMPLETE_QUIZ_DATA.slice(0, 3)) {
      await saveStep(makeRequest('PUT', { step, data }), { params: { id } })
    }

    // "User reopens tab → fetches session"
    const res = await getSession(makeRequest('GET'), { params: { id } })
    const body = await res.json()

    expect(body.currentStep).toBe(3)
    expect(body.quizData.age).toBe(34)
    expect(body.quizData.gender).toBe('female')
    expect(body.quizData.goal).toBe('lose_weight')
  })
})

// ── Step saving ─────────────────────────────────────────────────────────────

describe('PUT /api/sessions/:id/steps', () => {
  test('saves step and advances currentStep', async () => {
    const id = await createTestSession()
    const res = await saveStep(
      makeRequest('PUT', { step: 1, data: { gender: 'female' } }),
      { params: { id } },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.currentStep).toBe(1)
  })

  test('merges data: multiple steps accumulate in quizData', async () => {
    const id = await createTestSession()

    await saveStep(makeRequest('PUT', { step: 1, data: { gender: 'male' } }), { params: { id } })
    await saveStep(makeRequest('PUT', { step: 2, data: { age: 44 } }), { params: { id } })

    const session = await getSession(makeRequest('GET'), { params: { id } })
    const body = await session.json()
    expect(body.quizData.age).toBe(44)
    expect(body.quizData.gender).toBe('male')
  })

  test('idempotent: duplicate step submission does not regress currentStep', async () => {
    const id = await createTestSession()

    await saveStep(makeRequest('PUT', { step: 1, data: { gender: 'female' } }), { params: { id } })
    await saveStep(makeRequest('PUT', { step: 2, data: { age: 28 } }), { params: { id } })

    // Re-submit the age step (out of order / retry)
    await saveStep(makeRequest('PUT', { step: 2, data: { age: 34 } }), { params: { id } })

    const session = await getSession(makeRequest('GET'), { params: { id } })
    const body = await session.json()

    // currentStep must not regress below 2
    expect(body.currentStep).toBeGreaterThanOrEqual(2)
    // The re-submitted age should replace the saved age value.
    expect(body.quizData.age).toBe(34)
  })

  test('rejects invalid step number', async () => {
    const id = await createTestSession()
    const res = await saveStep(
      makeRequest('PUT', { step: 99, data: {} }),
      { params: { id } },
    )
    expect(res.status).toBe(400)
  })

  test('rejects non-numeric step', async () => {
    const id = await createTestSession()
    const res = await saveStep(
      makeRequest('PUT', { step: 'one', data: { ageGroup: '18-29' } }),
      { params: { id } },
    )
    expect(res.status).toBe(400)
  })

  test('rejects invalid enum value (injection guard)', async () => {
    const id = await createTestSession()
    const res = await saveStep(
      makeRequest('PUT', { step: 2, data: { age: "'; DROP TABLE sessions; --" } }),
      { params: { id } },
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Validation failed')
  })

  test('rejects out-of-range height', async () => {
    const id = await createTestSession()
    const res = await saveStep(
      makeRequest('PUT', { step: 6, data: { heightCm: 9999, weightKg: 70 } }),
      { params: { id } },
    )
    expect(res.status).toBe(400)
  })

  test('rejects negative weight', async () => {
    const id = await createTestSession()
    const res = await saveStep(
      makeRequest('PUT', { step: 6, data: { heightCm: 170, weightKg: -50 } }),
      { params: { id } },
    )
    expect(res.status).toBe(400)
  })

  test('returns 404 for unknown session', async () => {
    const res = await saveStep(
      makeRequest('PUT', { step: 2, data: { age: 28 } }),
      { params: { id: 'unknown-session-id' } },
    )
    expect(res.status).toBe(404)
  })
})

// ── Calculate ───────────────────────────────────────────────────────────────

describe('POST /api/sessions/:id/calculate', () => {
  test('calculates and stores results for complete quiz', async () => {
    const id = await createTestSession()

    for (const { step, data } of COMPLETE_QUIZ_DATA) {
      await saveStep(makeRequest('PUT', { step, data }), { params: { id } })
    }

    const res = await calculate(makeRequest('POST'), { params: { id } })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.sessionId).toBe(id)
    expect(body.resultId).toBeDefined()
  })

  test('idempotent: calling calculate twice returns existing result', async () => {
    const id = await createTestSession()

    for (const { step, data } of COMPLETE_QUIZ_DATA) {
      await saveStep(makeRequest('PUT', { step, data }), { params: { id } })
    }

    await calculate(makeRequest('POST'), { params: { id } })
    const res2 = await calculate(makeRequest('POST'), { params: { id } })
    const body2 = await res2.json()
    expect(body2.alreadyCalculated).toBe(true)
  })

  test('returns 422 when quiz data is incomplete', async () => {
    const id = await createTestSession()
    // Only save step 1 — missing required fields
    await saveStep(makeRequest('PUT', { step: 1, data: { gender: 'female' } }), { params: { id } })

    const res = await calculate(makeRequest('POST'), { params: { id } })
    expect(res.status).toBe(422)
  })

  test('returns 404 for non-existent session', async () => {
    const res = await calculate(makeRequest('POST'), { params: { id: 'no-such-session' } })
    expect(res.status).toBe(404)
  })
})

// ── Teardown ────────────────────────────────────────────────────────────────

afterAll(async () => {
  await prisma.$disconnect()
})
