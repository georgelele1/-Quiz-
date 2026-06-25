/**
 * POST /api/cleanup
 *
 * Purges expired sessions -- sessions where expiresAt has passed.
 * In production this would be called by a cron job (e.g. Vercel Cron,
 * GitHub Actions schedule, or pg_cron). Safe to call repeatedly (idempotent).
 *
 * Deleting the Session cascades to HealthResult via onDelete: Cascade.
 * The User record is kept -- they may return and retake the quiz.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const CRON_SECRET = process.env.CRON_SECRET

export async function POST(req: NextRequest) {
  // If CRON_SECRET is configured, require it as a Bearer token.
  // Allows unauthenticated calls only in local dev (no secret set).
  if (CRON_SECRET) {
    const auth = req.headers.get('authorization')
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }
  try {
    const now = new Date()

    const { count } = await prisma.session.deleteMany({
      where: {
        expiresAt: { lt: now },
      },
    })

    return NextResponse.json({
      purged: count,
      ranAt: now.toISOString(),
    })
  } catch (err) {
    console.error('[POST /api/cleanup]', err)
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 })
  }
}
