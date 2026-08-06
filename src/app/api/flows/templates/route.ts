import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { listFlowTemplates } from '@/lib/flows/templates'

export async function GET(request: Request) {
  try {
    await requireApiActor(request, 'admin')
    const templates = listFlowTemplates().map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      icon: t.icon,
      trigger_type: t.trigger_type,
      node_count: t.nodes.length,
    }))
    return NextResponse.json({ templates })
  } catch (error) {
    console.error('Error listing flow templates:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
