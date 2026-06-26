/**
 * Integration tests: Auth, differential results, and payment flow
 *
 * Tests:
 *  - Free user receives limited (redacted) results
 *  - Free user cannot access protected fields
 *  - POST /api/pay activates subscription
 *  - After payment, results endpoint returns full data
 *  - End-to-end: quiz → calculate → pay → full results
 *  - /pay idempotency: double-pay does not error
 *  - /pay before quiz completion is rejected
 *  - /results before calculation is 404
 */

import { prisma } from '@/lib/prisma'
import { NextRequest } from 'next/server'

import { POST as createSession } from '@/app/api/sessions/route'
import { PUT as saveStep } from '@/app/api/sessions/[id]/steps/route'
import { POST as calculate } from '@/app/api/sessions/[id]/calculate/route'
import { GET as getResults } from '@/app/api/results/[sessionId]/route'
import { POST as pay } from '@/app/api/pay/route'
import { POST as cancelSubscription } from '@/app/api/subscription/cancel/route'

jest.setTimeout(30000)

// ── Helpers ────────────────────────────────────────────────────────────────

let sessionCookie = ''

beforeEach(() => {
  sessionCookie = ''
})

function makeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost:3000', {
    method,
    headers: { 'Content-Type': 'application/json', ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
}

function futureDate(days = 84): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

const COMPLETE_STEPS = [
  { step: 1,  data: { gender: 'male' } },
  { step: 2,  data: { age: 34 } },
  { step: 3,  data: { goal: 'lose_weight' } },
  { step: 4,  data: { focusAreas: ['belly_fat'] } },
  { step: 5,  data: { activityTypes: ['gym'] } },
  { step: 6,  data: { heightCm: 178, weightKg: 95 } },
  { step: 7,  data: { targetWeightKg: 80 } },
  { step: 8,  data: { activityLevel: 'light' } },
  { step: 9,  data: { dietPreference: 'no_preference' } },
  { step: 10, data: { targetDate: futureDate(), targetTimelineWeeks: 12 } },
  { step: 11, data: { motivation: 'conference', motivationDetail: 'Annual leadership conference' } },
  { step: 12, data: {} },
]

async function setupCompletedSession(withAccount = false): Promise<string> {
  const req = makeRequest('POST', {})
  const res = await createSession(req)
  sessionCookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
  const { id } = await res.json()

  const steps = withAccount
    ? COMPLETE_STEPS.map(({ step, data }) =>
        step === 12
          ? { step, data: { email: `test-${Date.now()}-${Math.random()}@example.com` } }
          : { step, data },
      )
    : COMPLETE_STEPS

  for (const { step, data } of steps) {
    await saveStep(makeRequest('PUT', { step, data }), { params: { id } })
  }

  await calculate(makeRequest('POST'), { params: { id } })
  return id
}

function setupCompletedAccountSession(): Promise<string> {
  return setupCompletedSession(true)
}

// ── Free user results ───────────────────────────────────────────────────────

describe('GET /api/results/:sessionId — FREE user', () => {
  test('returns access="limited" with only BMI and dailyCalories', async () => {
    const id = await setupCompletedSession()

    const res = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.access).toBe('limited')
    expect(body.bmi).toBeDefined()
    expect(body.bmiCategory).toBeDefined()
    expect(body.dailyCalories).toBeDefined()
  })

  test('FREE user does NOT receive macro breakdown', async () => {
    const id = await setupCompletedSession()
    const res = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    const body = await res.json()

    expect(body.proteinGrams).toBeUndefined()
    expect(body.carbGrams).toBeUndefined()
    expect(body.fatGrams).toBeUndefined()
  })

  test('FREE user does NOT receive weeklyProjection', async () => {
    const id = await setupCompletedSession()
    const res = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    const body = await res.json()

    expect(body.weeklyProjection).toBeUndefined()
  })

  test('FREE user does NOT receive targetDate', async () => {
    const id = await setupCompletedSession()
    const res = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    const body = await res.json()

    expect(body.targetDate).toBeUndefined()
  })

  test('FREE response includes upgrade message', async () => {
    const id = await setupCompletedSession()
    const res = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    const body = await res.json()

    expect(typeof body.message).toBe('string')
    expect(body.message.length).toBeGreaterThan(10)
  })

  test('returns 404 when results not yet calculated', async () => {
    // Create session but skip calculate
    const req = makeRequest('POST', {})
    const sessionRes = await createSession(req)
    const { id } = await sessionRes.json()
    sessionCookie = sessionRes.headers.get('set-cookie')?.split(';')[0] ?? ''

    const res = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    expect(res.status).toBe(404)
  })

  test('returns 404 for unknown session', async () => {
    const res = await getResults(makeRequest('GET'), { params: { sessionId: 'ghost-session' } })
    expect(res.status).toBe(404)
  })
})

// ── Payment flow ────────────────────────────────────────────────────────────

describe('GET /api/results/:sessionId — PAID user', () => {
  test('receives full access after paid subscription activation', async () => {
    const id = await setupCompletedAccountSession()
    await pay(makeRequest('POST', { sessionId: id, plan: 'monthly' }))
    const res = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.access).toBe('full')
    expect(body.accessReason).toBe('subscribed')
    expect(body.proteinGrams).toBeDefined()
    expect(body.weeklyProjection).toBeDefined()
  })
})

describe('POST /api/pay', () => {
  test('activates subscription to ACTIVE', async () => {
    const id = await setupCompletedAccountSession()

    const res = await pay(makeRequest('POST', { sessionId: id, plan: 'monthly' }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.status).toBe('ACTIVE')
    expect(body.plan).toBe('monthly')
    expect(body.activatedAt).toBeDefined()
    expect(body.expiresAt).toBeDefined()
  })

  test('records a mock payment transaction for paid plans', async () => {
    const id = await setupCompletedAccountSession()

    const payRes = await pay(makeRequest('POST', { sessionId: id, plan: 'weekly' }))
    expect(payRes.status).toBe(200)

    const session = await prisma.session.findUnique({ where: { id }, include: { user: true } })
    expect(session!.userId).toBeTruthy()

    const payment = await prisma.paymentTransaction.findFirst({
      where: { userId: session!.userId!, sessionId: id },
    })

    expect(payment).toBeTruthy()
    expect(payment!.plan).toBe('weekly')
    expect(payment!.amountCents).toBe(499)
    expect(payment!.status).toBe('SUCCEEDED')
    expect(payment!.provider).toBe('mock')
  })

  test('cancels active subscription and stores cancellation metadata', async () => {
    const id = await setupCompletedAccountSession()
    await pay(makeRequest('POST', { sessionId: id, plan: 'monthly' }))

    const res = await cancelSubscription(makeRequest('POST', { sessionId: id, reason: 'test_cancel' }))
    expect(res.status).toBe(200)

    const session = await prisma.session.findUnique({ where: { id }, include: { user: { include: { subscription: true } } } })
    expect(session!.user!.subscription!.status).toBe('CANCELLED')
    expect(session!.user!.subscription!.cancelledAt).toBeTruthy()
    expect(session!.user!.subscription!.cancelReason).toBe('test_cancel')
  })

  test('yearly plan also works', async () => {
    const id = await setupCompletedAccountSession()

    const res = await pay(makeRequest('POST', { sessionId: id, plan: 'yearly' }))
    const body = await res.json()

    expect(body.status).toBe('ACTIVE')
    expect(body.plan).toBe('yearly')
  })

  test('idempotent: double payment returns success without error', async () => {
    const id = await setupCompletedAccountSession()

    await pay(makeRequest('POST', { sessionId: id, plan: 'monthly' }))
    const res2 = await pay(makeRequest('POST', { sessionId: id, plan: 'monthly' }))

    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2.success).toBe(true)
    expect(body2.alreadyActive).toBe(true)
  })

  test('rejects payment before quiz completion', async () => {
    const req = makeRequest('POST', {})
    const sessionRes = await createSession(req)
    const { id } = await sessionRes.json()
    sessionCookie = sessionRes.headers.get('set-cookie')?.split(';')[0] ?? ''

    const res = await pay(makeRequest('POST', { sessionId: id }))
    expect(res.status).toBe(422)
  })

  test('rejects missing sessionId', async () => {
    const res = await pay(makeRequest('POST', {}))
    expect(res.status).toBe(400)
  })

  test('rejects unknown sessionId', async () => {
    const res = await pay(makeRequest('POST', { sessionId: 'no-such-session' }))
    expect(res.status).toBe(404)
  })

  test('defaults to monthly plan when plan is invalid', async () => {
    const id = await setupCompletedAccountSession()
    const res = await pay(makeRequest('POST', { sessionId: id, plan: 'quarterly' }))
    const body = await res.json()
    expect(body.plan).toBe('monthly')
  })
})

// ── Full access after payment ───────────────────────────────────────────────

describe('Results after payment — ACTIVE user', () => {
  test('returns access="full" with all fields', async () => {
    const id = await setupCompletedAccountSession()
    await pay(makeRequest('POST', { sessionId: id, plan: 'monthly' }))

    const res = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.access).toBe('full')
  })

  test('full results contain macro breakdown', async () => {
    const id = await setupCompletedAccountSession()
    await pay(makeRequest('POST', { sessionId: id }))

    const res = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    const body = await res.json()

    expect(typeof body.proteinGrams).toBe('number')
    expect(typeof body.carbGrams).toBe('number')
    expect(typeof body.fatGrams).toBe('number')
    expect(body.proteinGrams).toBeGreaterThan(0)
  })

  test('full results contain weeklyProjection array', async () => {
    const id = await setupCompletedAccountSession()
    await pay(makeRequest('POST', { sessionId: id }))

    const res = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    const body = await res.json()

    expect(Array.isArray(body.weeklyProjection)).toBe(true)
    expect(body.weeklyProjection.length).toBeGreaterThan(0)
  })

  test('full results contain weeksToGoal', async () => {
    const id = await setupCompletedAccountSession()
    await pay(makeRequest('POST', { sessionId: id }))

    const res = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    const body = await res.json()

    expect(typeof body.weeksToGoal).toBe('number')
    expect(body.weeksToGoal).toBeGreaterThan(0)
  })

  test('full results contain ISO targetDate', async () => {
    const id = await setupCompletedAccountSession()
    await pay(makeRequest('POST', { sessionId: id }))

    const res = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    const body = await res.json()

    expect(typeof body.targetDate).toBe('string')
    expect(new Date(body.targetDate).getTime()).toBeGreaterThan(Date.now())
  })

  test('E2E: quiz → calculate → pay → full results (no redacted fields)', async () => {
    const id = await setupCompletedSession()

    // Before pay: limited
    const limitedRes = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    const limited = await limitedRes.json()
    expect(limited.access).toBe('limited')
    expect(limited.weeklyProjection).toBeUndefined()

    // Attach an account after the anonymous result has been shown, then pay.
    const attachAccount = await saveStep(
      makeRequest('PUT', { step: 12, data: { email: `upgrade-${Date.now()}@example.com` } }),
      { params: { id } },
    )
    expect(attachAccount.status).toBe(200)

    // Pay
    await pay(makeRequest('POST', { sessionId: id, plan: 'yearly' }))

    // After pay: full
    const fullRes = await getResults(makeRequest('GET'), { params: { sessionId: id } })
    const full = await fullRes.json()
    expect(full.access).toBe('full')
    expect(full.weeklyProjection).toBeDefined()
    expect(full.proteinGrams).toBeDefined()
  })
})

// ── Teardown ────────────────────────────────────────────────────────────────

afterAll(async () => {
  await prisma.$disconnect()
})
