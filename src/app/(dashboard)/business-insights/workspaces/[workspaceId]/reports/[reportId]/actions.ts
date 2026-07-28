"use server";

import { revalidatePath } from "next/cache";
import { forbidden, redirect } from "next/navigation";

import { getCurrentAccount } from "@/lib/auth/account";
import {
  getReport,
  updateReportPreferences,
} from "@/lib/business-insights/client";
import { buildReportView } from "@/lib/business-insights/view-model";

export async function saveReportPreferences(formData: FormData) {
  const workspaceId = String(formData.get("workspace_id") ?? "");
  const reportId = String(formData.get("report_id") ?? "");
  const intervalDays = Number(formData.get("interval_days"));
  const reportEmail = String(formData.get("report_email") ?? "").trim();
  const path = `/business-insights/workspaces/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}`;

  if (!workspaceId || !reportId) forbidden();
  if (!Number.isInteger(intervalDays) || intervalDays < 15 || intervalDays > 30) {
    redirect(`${path}?preferences=invalid`);
  }
  if (reportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reportEmail)) {
    redirect(`${path}?preferences=invalid`);
  }

  const account = await getCurrentAccount();
  const actor = { userId: account.userId, accountId: account.accountId };
  const view = buildReportView(await getReport(actor, workspaceId, reportId));
  if (!view.canConfigure || (reportEmail && !view.canConfigureEmail)) forbidden();

  await updateReportPreferences(actor, workspaceId, {
    interval_days: intervalDays,
    report_email: reportEmail || null,
  });
  revalidatePath(path);
  redirect(`${path}?preferences=saved`);
}
