export type DataQuality = "confirmed" | "inferred" | "estimated";

export interface InsightMetric {
  key: string;
  label: string;
  value: string | number;
  change?: string | null;
  quality: DataQuality;
  source: string;
  period: string;
  coverage?: string | null;
  methodology?: string | null;
}

export interface PriorityAction {
  title: string;
  reason: string;
  urgency: "today" | "seven_days" | string;
  expected_impact?: string | null;
}

export interface PlanCapabilities {
  analytics_basic: boolean;
  analytics_full: boolean;
  report_history: boolean;
  report_download: boolean;
  report_preferences: boolean;
  report_email: boolean;
  [capability: string]: boolean;
}

export interface BusinessReport {
  id: string;
  workspace_id: string;
  business_name: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  status: string;
  executive_summary: string;
  business_state: string;
  changes: string[];
  risks: string[];
  opportunities: string[];
  priority_actions: PriorityAction[];
  basic_analytics: InsightMetric[];
  full_analytics: InsightMetric[];
  data_quality: {
    coverage: string;
    missing_sources: string[];
    notes: string[];
  };
  has_sufficient_data: boolean;
}

export interface ReportEnvelope {
  plan: string;
  plan_capabilities: PlanCapabilities;
  report: BusinessReport;
}

export interface ReportHistoryItem {
  id: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  status: string;
}

export interface ReportHistoryEnvelope {
  reports: ReportHistoryItem[];
}

export interface ReportPreferences {
  interval_days: number;
  report_email: string | null;
  next_report_at: string | null;
}
