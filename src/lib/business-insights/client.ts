import "server-only";

import type {
  ReportEnvelope,
  ReportHistoryEnvelope,
  ReportPreferences,
} from "./types";

export class BusinessHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BusinessHubError";
  }
}

export interface BusinessHubActor {
  userId: string;
  accountId: string;
}

function configuration() {
  const baseUrl = process.env.BUSINESS_HUB_URL?.trim();
  const secret = process.env.BH_INTERNAL_SECRET?.trim();
  if (!baseUrl || !secret) {
    throw new BusinessHubError(503, "Business Hub is not configured");
  }

  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    throw new BusinessHubError(503, "Business Hub URL is invalid");
  }
  return { origin, secret };
}

export function getCanonicalSiteOrigin(): string | null {
  const configured = (
    process.env.WACRM_SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL
  )?.trim();
  if (!configured) return null;

  try {
    const url = new URL(configured);
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
      return null;
    }
    if (process.env.NODE_ENV === "production" && url.hostname === "localhost") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function request(
  actor: BusinessHubActor,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const { origin, secret } = configuration();
  const siteOrigin = getCanonicalSiteOrigin();
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Internal-Secret", secret);
  headers.set("X-WACRM-User-ID", actor.userId);
  headers.set("X-WACRM-Account-ID", actor.accountId);
  if (siteOrigin) headers.set("X-WACRM-Site-URL", siteOrigin);
  if (init?.body) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(new URL(path, origin), {
      ...init,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new BusinessHubError(
      502,
      error instanceof Error && error.name === "TimeoutError"
        ? "Business Hub request timed out"
        : "Business Hub is unavailable",
    );
  }

  if (!response.ok) {
    throw new BusinessHubError(response.status, "Business Hub request failed");
  }
  return response;
}

function workspacePath(workspaceId: string, suffix: string): string {
  return `/api/business-insights/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;
}

export async function getReport(
  actor: BusinessHubActor,
  workspaceId: string,
  reportId: string,
): Promise<ReportEnvelope> {
  const response = await request(
    actor,
    workspacePath(workspaceId, `/reports/${encodeURIComponent(reportId)}`),
  );
  return response.json() as Promise<ReportEnvelope>;
}

export async function getReportHistory(
  actor: BusinessHubActor,
  workspaceId: string,
): Promise<ReportHistoryEnvelope> {
  const response = await request(actor, workspacePath(workspaceId, "/reports"));
  return response.json() as Promise<ReportHistoryEnvelope>;
}

export async function getReportPreferences(
  actor: BusinessHubActor,
  workspaceId: string,
): Promise<ReportPreferences> {
  const response = await request(actor, workspacePath(workspaceId, "/preferences"));
  return response.json() as Promise<ReportPreferences>;
}

export async function updateReportPreferences(
  actor: BusinessHubActor,
  workspaceId: string,
  preferences: Pick<ReportPreferences, "interval_days" | "report_email">,
): Promise<ReportPreferences> {
  const response = await request(actor, workspacePath(workspaceId, "/preferences"), {
    method: "PUT",
    body: JSON.stringify(preferences),
  });
  return response.json() as Promise<ReportPreferences>;
}

export async function downloadReport(
  actor: BusinessHubActor,
  workspaceId: string,
  reportId: string,
): Promise<Response> {
  return request(
    actor,
    workspacePath(
      workspaceId,
      `/reports/${encodeURIComponent(reportId)}/download`,
    ),
    { headers: { Accept: "application/pdf" } },
  );
}
