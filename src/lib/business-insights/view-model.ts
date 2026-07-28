import type { ReportEnvelope } from "./types";

export function buildReportView(envelope: ReportEnvelope) {
  const { plan_capabilities: capabilities, report } = envelope;
  const canViewBasic = capabilities.analytics_basic === true;
  const canViewFull = canViewBasic && capabilities.analytics_full === true;

  return {
    plan: envelope.plan,
    capabilities,
    report,
    metrics: canViewBasic
      ? [
          ...report.basic_analytics,
          ...(canViewFull ? report.full_analytics : []),
        ]
      : [],
    canViewBasic,
    canViewFull,
    canDownload: canViewFull && capabilities.report_download === true,
    canConfigure:
      canViewFull && capabilities.report_preferences === true,
    canConfigureEmail:
      canViewFull && capabilities.report_email === true,
    hasData: report.has_sufficient_data && canViewBasic,
  };
}
