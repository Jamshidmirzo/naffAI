// Shared TypeScript types for the Marketing module.
// Mirrors the backend `apps.marketing` selector/service shapes.

export interface AdSpendPart {
  amount: string;
  cac: string | null;
  roi_pct: string | null;
  revenue_per_dollar: string | null;
}

export interface TopProduct {
  name: string;
  count: number;
}

export interface TopOperator {
  operator_id: number;
  name: string;
  count: number;
  total: string;
}

export interface SourceRow {
  source_name: string;
  sheet_source_id: number | null;
  kind: "sheet" | "bot" | "manual" | "other";
  leads: number;
  converted: number;
  conv_rate: number;
  revenue: string;
  avg_check: string;
  avg_time_to_conv_hours: number | null;
  top_products: TopProduct[];
  top_operators: TopOperator[];
  prev_period: { leads: number; converted: number; conv_rate: number };
  delta_pp: number;
  delta_leads: number;
  adspend: AdSpendPart;
}

export interface FunnelRow {
  source_name: string;
  total: number;
  new: number;
  assigned: number;
  in_progress: number;
  contacted_telegram: number;
  callback_scheduled: number;
  no_answer: number;
  won: number;
  lost: number;
  new_pct: number;
  assigned_pct: number;
  in_progress_pct: number;
  contacted_telegram_pct: number;
  callback_scheduled_pct: number;
  no_answer_pct: number;
  won_pct: number;
  lost_pct: number;
}

export interface TimePatternHour {
  hour: number;
  leads: number;
  sales: number;
}

export interface TimePatternSource {
  source_name: string;
  hours: TimePatternHour[];
}

export interface RejectionReason {
  text: string;
  count: number;
  pct: number;
}

export interface RejectionRow {
  source_name: string;
  total_lost: number;
  reasons: RejectionReason[];
}

export interface CohortRow {
  week: string;
  week_start: string;
  leads_count: number;
  conv_7d: number;
  conv_30d: number;
  conv_rate_7d: number;
  conv_rate_30d: number;
}

export interface WowDelta {
  current: { leads: number; converted: number; revenue: string; conv_rate: number };
  previous: { leads: number; converted: number; revenue: string; conv_rate: number };
  delta: {
    leads_pct: number | null;
    converted_pct: number | null;
    revenue_pct: number | null;
    conv_rate_pp: number;
  };
}

export interface ChannelInSource {
  name: string;
  count: number;
  share_pct: number;
}

export interface ChannelSourceRow {
  source_name: string;
  total_partner_lines: number;
  channels: ChannelInSource[];
}

export interface MarketingTotals {
  leads: number;
  converted: number;
  conv_rate: number;
  sales_count: number;
  revenue: string;
  avg_check: string;
  spend: string;
  cac: string | null;
  roi_pct: string | null;
}

export interface DashboardPayload {
  period: { start: string; end: string; days: number };
  totals: MarketingTotals;
  sources: SourceRow[];
  funnels: FunnelRow[];
  time_patterns: { sources: TimePatternSource[] };
  rejection_reasons: RejectionRow[];
  channels: ChannelSourceRow[];
  cohorts: CohortRow[];
  wow: WowDelta;
  adspend_summary: { has_data: boolean; total: string };
  latest_insight_id: number | null;
  latest_insight_generated_at: string | null;
}

export interface Recommendation {
  priority: "high" | "medium" | "low";
  action: string;
  source?: string;
  evidence?: string;
  expected_impact?: string;
  confidence?: number;
}

export interface Highlight {
  type: "win" | "warn" | "insight";
  text: string;
}

export interface StructuredInsight {
  summary: string;
  highlights: Highlight[];
  recommendations: Recommendation[];
  questions_for_owner?: string[];
}

export interface InsightRecord {
  id: number;
  period_start: string;
  period_end: string;
  structured_output: StructuredInsight;
  actions_taken: { index: number; done_at?: string; user_id?: number | null }[];
  summary: string;
  model_version: string;
  provider_used?: string;
  created_at: string;
  updated_at: string;
  // Legacy back-compat fields
  lead_quality_by_source?: Record<string, { leads: number; converted: number; conversion_rate: number }>;
  targeting_recommendations?: string[];
  top_products?: { product: string; mentions: number }[];
}

export interface AdSpendRow {
  id: number;
  period_start: string;
  period_end: string;
  source: number | null;
  source_label: string;
  source_name: string;
  resolved_label: string;
  amount: string;
  currency: string;
  note: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}
