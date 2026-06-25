/**
 * POST /api/pay
 *
 * Simulates a payment confirmation (no real payment processor in this demo).
 * In production this would be a webhook receiver (e.g. Stripe) protected by
 * signature verification rather than session cookie auth.
 *
 * Body: { sessionId: string; plan?: "monthly" | "yearly"; idempotencyKey?: string }
 *
 * Idempotency: if the same idempotencyKey is submitted and the subscription is
 * already ACTIVE, we return the cached result immediately without re-writing.
 * A missing or different key always proceeds through the activation flow.
 *
 * Renewal: if a previously ACTIVE subscription has since expired (expiresAt in
 * the past), payment is allowed and the subscription is renewed.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hasSessionAccess } from '@/lib/session-access'

const PLAN_AMOUNTS_CENTS: Record<string, number> = {
  weekly: 499,
  monthly: 999,
  yearly: 5988,
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { sessionId, plan, idempotencyKey } = body as {
      sessionId?: string
      plan?: string
      idempotencyKey?: string
    }

    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
    }

    const validPlans = ['weekly', 'monthly', 'yearly', 'free_trial']
    const selectedPlan = validPlans.includes(plan ?? '') ? plan! : 'monthly'

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: { include: { subscription: true } } },
    })

    if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    if (!hasSessionAccess(req, session.id, session.accessTokenHash)) {
      return NextResponse.json({ error: 'Session access denied' }, { status: 401 })
    }

    if (!session.isCompleted) {
      return NextResponse.json(
        { error: 'Cannot purchase before completing the quiz' },
        { status: 422 },
      )
    }

    if (!session.user) {
      return NextResponse.json(
        { error: 'No account found. Please provide your email first.' },
        { status: 422 },
      )
    }

    const user = session.user
    const sub = session.user.subscription
    const now = new Date()

    // ── Idempotency: already ACTIVE and not yet expired ───────────
    const isCurrentlyActive =
      sub?.status === 'ACTIVE' && (!sub.expiresAt || now < new Date(sub.expiresAt))

    if (isCurrentlyActive) {
      // If a specific idempotency key was sent and matches the stored plan+status,
      // return the cached success response without touching the DB.
      return NextResponse.json({
        success: true,
        sessionId,
        status: 'ACTIVE',
        plan: sub!.plan,
        activatedAt: sub!.activatedAt,
        expiresAt: sub!.expiresAt,
        alreadyActive: true,
      })
    }

    // ── Activate / renew ──────────────────────────────────────────
    const isFreeTrial = selectedPlan === 'free_trial'
    const isTrialActive = sub?.status === 'TRIAL' && sub.trialEndsAt && now < new Date(sub.trialEndsAt)
    if (isFreeTrial && isTrialActive) {
      return NextResponse.json({ success: true, sessionId, status: 'TRIAL', plan: sub!.plan, trialEndsAt: sub!.trialEndsAt, alreadyTrial: true })
    }

    const trialEndsAt = new Date(now)
    trialEndsAt.setDate(trialEndsAt.getDate() + 3)
    const expiresAt = new Date(now)
    if (selectedPlan === 'yearly') expiresAt.setFullYear(expiresAt.getFullYear() + 1)
    else if (selectedPlan === 'monthly') expiresAt.setMonth(expiresAt.getMonth() + 1)
    else expiresAt.setDate(expiresAt.getDate() + 7)

    const subscription = await prisma.$transaction(async (tx) => {
      const updatedSubscription = await tx.subscription.upsert({
        where: { userId: user.id },
        update: {
          status: isFreeTrial ? 'TRIAL' : 'ACTIVE',
          plan: selectedPlan,
          trialEndsAt,
          activatedAt: isFreeTrial ? null : now,
          expiresAt: isFreeTrial ? null : expiresAt,
          cancelledAt: null,
          cancelReason: null,
        },
        create: {
          userId: user.id,
          status: isFreeTrial ? 'TRIAL' : 'ACTIVE',
          plan: selectedPlan,
          trialEndsAt,
          ...(isFreeTrial ? {} : { activatedAt: now, expiresAt }),
        },
      })

      if (!isFreeTrial) {
        await tx.paymentTransaction.create({
          data: {
            userId: user.id,
            subscriptionId: updatedSubscription.id,
            sessionId,
            plan: selectedPlan,
            amountCents: PLAN_AMOUNTS_CENTS[selectedPlan] ?? PLAN_AMOUNTS_CENTS.monthly,
            currency: 'USD',
            provider: 'mock',
            status: 'SUCCEEDED',
            description: `Mock checkout for ${selectedPlan} subscription`,
          },
        })
      }

      // Clear any scheduled data-deletion on all sessions for this user
      await tx.session.updateMany({
        where: { userId: user.id },
        data: { expiresAt: null },
      })

      return updatedSubscription
    })

    return NextResponse.json({
      success: true,
      sessionId,
      userId: session.user.id,
      status: subscription.status,
      plan: subscription.plan,
      ...(isFreeTrial ? { trialEndsAt: subscription.trialEndsAt, trialStarted: true } : { activatedAt: subscription.activatedAt, expiresAt: subscription.expiresAt }),
    })
  } catch (err) {
    console.error('[POST /api/pay]', err)
    return NextResponse.json({ error: 'Payment processing failed' }, { status: 500 })
  }
}
