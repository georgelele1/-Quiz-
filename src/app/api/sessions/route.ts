/**
 * POST /api/sessions
 * Creates a new anonymous quiz session (no user yet -- email collected at step 8).
 * Idempotent via clientId.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { createSessionAccessToken, setSessionAccessCookie, hasSessionAccess } from '@/lib/session-access'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const clientId: string | undefined = body?.clientId

    if (clientId) {
      const existing = await prisma.session.findUnique({
        where: { id: clientId },
        include: { user: { include: { subscription: true } } },
      })
      if (existing) {
        // Re-issue is only allowed if the caller already holds a valid cookie
        // for this session. Without this check, anyone who guesses a session ID
        // could hijack it by calling POST /api/sessions with that clientId.
        if (!hasSessionAccess(req, existing.id, existing.accessTokenHash)) {
          return NextResponse.json({ error: 'Session access denied' }, { status: 401 })
        }
        // Issue a fresh token so the browser gets a valid auth cookie even if
        // the original was lost (e.g. page refresh on same device).
        const access = createSessionAccessToken()
        await prisma.session.update({
          where: { id: clientId },
          data: { accessTokenHash: access.hash },
        })
        const response = NextResponse.json(toSessionResponse(existing), { status: 200 })
        setSessionAccessCookie(response, existing.id, access.token)
        return response
      }
    }

    const access = createSessionAccessToken()
    const session = await prisma.session.create({
      data: {
        id: clientId ?? undefined,
        quizData: {},
        accessTokenHash: access.hash,
      },
      include: { user: { include: { subscription: true } } },
    })

    const response = NextResponse.json(toSessionResponse(session), { status: 201 })
    setSessionAccessCookie(response, session.id, access.token)
    return response
  } catch (err) {
    console.error('[POST /api/sessions]', err)
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 })
  }
}

type SessionResponseSource = {
  id: string
  currentStep: number
  version: number
  isCompleted: boolean
  quizData: unknown
  user?: {
    subscription?: {
      status: string
      trialEndsAt?: Date | null
    } | null
  } | null
}

// Kept private to this route module: App Router route files may only export
// supported handlers and route configuration.
function toSessionResponse(session: SessionResponseSource) {
  const sub = session.user?.subscription ?? null
  const now = new Date()

  let trialDaysLeft: number | undefined
  if (sub?.status === 'TRIAL' && sub.trialEndsAt) {
    const ms = new Date(sub.trialEndsAt).getTime() - now.getTime()
    trialDaysLeft = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)))
  }

  return {
    id: session.id,
    currentStep: session.currentStep,
    version: session.version,
    isCompleted: session.isCompleted,
    quizData: session.quizData,
    subscription: sub
      ? {
          status: sub.status,
          trialEndsAt: sub.trialEndsAt?.toISOString(),
          trialDaysLeft,
        }
      : null,
  }
}
