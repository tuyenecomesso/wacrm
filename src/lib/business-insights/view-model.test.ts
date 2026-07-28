import { describe, expect, it } from "vitest";

import type { ReportEnvelope } from "./types";
import { buildReportView } from "./view-model";

function envelope(overrides: Partial<ReportEnvelope> = {}): ReportEnvelope {
  return {
    plan: "plus",
    plan_capabilities: {
      analytics_basic: true,
      analytics_full: false,
      report_history: true,
      report_download: false,
      report_preferences: false,
      report_email: false,
    },
    report: {
      id: "report-1",
      workspace_id: "workspace-1",
      business_name: "Kamba Comercial",
      period_start: "2026-07-01",
      period_end: "2026-07-15",
      generated_at: "2026-07-16T06:00:00Z",
      status: "ready",
      executive_summary: "Operacao estavel.",
      business_state: "Estavel",
      changes: [],
      risks: [],
      opportunities: [],
      priority_actions: [],
      basic_analytics: [
        {
          key: "conversations",
          label: "Conversas",
          value: 40,
          quality: "confirmed",
          source: "WhatsApp",
          period: "1-15 Julho",
        },
      ],
      full_analytics: [
        {
          key: "potential_revenue",
          label: "Receita potencial",
          value: "AOA 50 000",
          quality: "estimated",
          source: "Intencoes",
          period: "1-15 Julho",
        },
      ],
      data_quality: { coverage: "80%", missing_sources: [], notes: [] },
      has_sufficient_data: true,
    },
    ...overrides,
  };
}

describe("buildReportView", () => {
  it("shows only basic analytics and no document controls for Plus", () => {
    const view = buildReportView(envelope());
    expect(view.metrics.map((metric) => metric.key)).toEqual(["conversations"]);
    expect(view.canViewFull).toBe(false);
    expect(view.canDownload).toBe(false);
    expect(view.canConfigure).toBe(false);
  });

  it("shows full analytics, download and preferences for Business", () => {
    const source = envelope();
    source.plan = "business";
    source.plan_capabilities = {
      ...source.plan_capabilities,
      analytics_full: true,
      report_download: true,
      report_preferences: true,
      report_email: true,
    };
    const view = buildReportView(source);
    expect(view.metrics.map((metric) => metric.key)).toEqual([
      "conversations",
      "potential_revenue",
    ]);
    expect(view.canDownload).toBe(true);
    expect(view.canConfigureEmail).toBe(true);
  });

  it("removes Business controls immediately after a downgrade", () => {
    const source = envelope();
    source.plan_capabilities.report_download = true;
    source.plan_capabilities.report_preferences = true;
    expect(buildReportView(source).canDownload).toBe(false);
    expect(buildReportView(source).canConfigure).toBe(false);
  });

  it("returns an explicit no-data state when the report is insufficient", () => {
    const source = envelope();
    source.report.has_sufficient_data = false;
    expect(buildReportView(source).hasData).toBe(false);
  });
});
