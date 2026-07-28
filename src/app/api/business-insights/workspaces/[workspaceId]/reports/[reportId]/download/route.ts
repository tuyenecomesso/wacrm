import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  BusinessHubError,
  downloadReport,
  getReport,
} from "@/lib/business-insights/client";
import { buildReportView } from "@/lib/business-insights/view-model";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string; reportId: string }> },
) {
  try {
    const { workspaceId, reportId } = await params;
    const account = await getCurrentAccount();
    const actor = { userId: account.userId, accountId: account.accountId };
    const view = buildReportView(await getReport(actor, workspaceId, reportId));
    if (!view.canDownload) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const response = await downloadReport(actor, workspaceId, reportId);
    return new Response(response.body, {
      status: 200,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/pdf",
        "content-disposition": response.headers.get("content-disposition") ?? `attachment; filename="business-report-${reportId}.pdf"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof BusinessHubError) {
      return NextResponse.json(
        { error: error.status === 403 ? "Forbidden" : "Report download failed" },
        { status: error.status },
      );
    }
    return toErrorResponse(error);
  }
}
