import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hasSessionAccess } from '@/lib/session-access'

export async function POST(req: NextRequest) {
  try {
    const { sessionId, reason } = await req.json() as { sessionId?: string; reason?: string }
    if (!sessionId) return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: { include: { subscription: true } } },
    })
    if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    if (!hasSessionAccess(req, session.id, session.accessTokenHash)) {
      return NextResponse.json({ error: 'Session access denied' }, { status: 401 })
    }
    if (!session.user?.subscription) {
      return NextResponse.json({ error: 'No subscription to cancel' }, { status: 404 })
    }

    const subscription = session.user.subscription
    if (subscription.status === 'CANCELLED') {
      return NextResponse.json({ success: true, status: 'CANCELLED', alreadyCancelled: true })
    }

    await prisma.subscription.update({
      where: { userId: session.user.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: reason?.trim() || 'user_requested',
      },
    })
    return NextResponse.json({ success: true, status: 'CANCELLED' })
  } catch (error) {
    console.error('[POST /api/subscription/cancel]', error)
    return NextResponse.json({ error: 'Unable to cancel subscription' }, { status: 500 })
  }
}
