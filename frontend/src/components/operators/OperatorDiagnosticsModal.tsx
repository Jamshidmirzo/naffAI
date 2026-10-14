import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  ExternalLink,
  Layers,
  Pause,
  Phone,
  PhoneCall,
  Play,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  UserCheck,
  UserX,
  Users,
  XCircle,
} from "lucide-react";
import { api } from "../../lib/api";
import { Button, Modal, StatusBadge, toast } from "../ui";
import { useT } from "../../lib/i18n";

export interface DiagnosticOperatorRow {
  id: number;
  full_name: string;
  phone: string;
  status: string;
  is_paused: boolean;
  paused_at: string | null;
  blocking_gate_enabled: boolean;
  require_checkin_enabled: boolean;
  checked_in_today: boolean;
  has_open_shift: boolean;
  working_count: number;
  quota_limit: number;
  postponed_count: number;
  carry_count: number;
  yesterday_unclosed_count: number;
  open_callbacks_count: number;
  blocking_leads_count: number;
  today_received_count: number;
  today_calls_count: number;
  last_lead_assigned_at: string | null;
  allowed_sheets: string[];
  has_sheet_restrictions: boolean;
  eligible: boolean;
  primary_blocker: string;
  primary_blocker_title_uz: string;
  primary_blocker_title_ru: string;
  reasons_uz: string[];
  reasons_ru: string[];
}

export interface DiagnosticSummary {
  total_operators: number;
  eligible_count: number;
  blocked_count: number;
  paused_count: number;
  quota_full_count: number;
  yesterday_backlog_count: number;
  gate_blocked_count: number;
  not_checked_in_count: number;
  orphans_count: number;
  auto_distribution_enabled: boolean;
  rr_batch_size: number;
}

export interface LeadItem {
  id: number;
  full_name: string;
  phone: string;
  status: string;
  status_label_uz: string;
  status_label_ru: string;
  updated_at: string | null;
  created_at: string | null;
  hours_since_update?: number;
  days_ago?: number;
}

export interface SelectedOperatorDetail {
  operator: DiagnosticOperatorRow;
  working_leads: LeadItem[];
  yesterday_leads: LeadItem[];
  recent_assignments: Array<{
    assignment_id: number;
    lead_id: number;
    lead_name: string;
    source: string;
    created_at: string | null;
  }>;
}

export interface DiagnosticsApiResponse {
  summary: DiagnosticSummary;
  operators: DiagnosticOperatorRow[];
  selected_detail: SelectedOperatorDetail | null;
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "Hech qachon";
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 10) return "Hozirgina";
  if (sec < 60) return `${sec} soniya oldin`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} daqiqa oldin`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} soat oldin`;
  return `${Math.floor(hr / 24)} kun oldin`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  initialOperatorId?: number | null;
}

export function OperatorDiagnosticsModal({ open, onClose, initialOperatorId }: Props) {
  const qc = useQueryClient();
  const t = useT();

  const [selectedId, setSelectedId] = useState<number | null>(initialOperatorId ?? null);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterTab, setFilterTab] = useState<"all" | "blocked" | "paused" | "eligible">("all");
  const [activeDetailTab, setActiveDetailTab] = useState<"yesterday" | "working" | "recent">("yesterday");
  const [reassignTargetOpId, setReassignTargetOpId] = useState<number | null>(null);
  const [isReassigning, setIsReassigning] = useState(false);

  useEffect(() => {
    if (initialOperatorId != null) {
      setSelectedId(initialOperatorId);
    }
  }, [initialOperatorId, open]);

  // Main diagnostics query with polling when open
  const diagQ = useQuery<DiagnosticsApiResponse>({
    queryKey: ["distribution-diagnostics", selectedId, searchTerm, filterTab],
    queryFn: () =>
      api
        .get<DiagnosticsApiResponse>("/leads/distribution-diagnostics/", {
          params: {
            operator_id: selectedId ?? undefined,
            search: searchTerm ? searchTerm : undefined,
            filter_status: filterTab !== "all" ? filterTab : undefined,
          },
        })
        .then((r) => r.data),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  });

  const summary = diagQ.data?.summary;
  const operators = diagQ.data?.operators ?? [];
  const selectedDetail = diagQ.data?.selected_detail;

  // Auto-select first operator if none selected yet
  useEffect(() => {
    if (selectedId == null && operators.length > 0) {
      setSelectedId(operators[0].id);
    }
  }, [operators, selectedId]);

  const effectiveSelectedId = selectedId ?? operators[0]?.id ?? null;
  const selectedOp = useMemo(() => {
    return operators.find((o) => o.id === effectiveSelectedId) ?? selectedDetail?.operator ?? null;
  }, [operators, effectiveSelectedId, selectedDetail]);

  // Pause toggle mutation
  const togglePauseMut = useMutation({
    mutationFn: async ({ opId, currentlyPaused }: { opId: number; currentlyPaused: boolean }) => {
      const endpoint = currentlyPaused ? `/operators/${opId}/unpause/` : `/operators/${opId}/pause/`;
      return api.post(endpoint);
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["distribution-diagnostics"] });
      qc.invalidateQueries({ queryKey: ["operators"] });
      qc.invalidateQueries({ queryKey: ["distribution-status"] });
      toast.success(
        vars.currentlyPaused
          ? "Operator pauzadan chiqarildi! Yangi lidlar beriladi."
          : "Operator pauzaga qo'yildi (yangi lidlar berilmaydi)."
      );
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Xatolik yuz berdi");
    },
  });

  // Gate toggle mutation
  const toggleGateMut = useMutation({
    mutationFn: async ({ opId, enableGate }: { opId: number; enableGate: boolean }) => {
      return api.patch(`/operators/${opId}/`, { blocking_gate_enabled: enableGate });
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["distribution-diagnostics"] });
      qc.invalidateQueries({ queryKey: ["operators"] });
      toast.success(
        vars.enableGate
          ? "Morning gate yoqildi: kechagi lidlar va callbacklar bloklaydi."
          : "Morning gate o'chirildi: operator har qanday holatda yangi lid oladi."
      );
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Xatolik yuz berdi");
    },
  });

  // Bulk reassign mutation for yesterday's stuck leads
  const bulkReassignMut = useMutation({
    mutationFn: async ({
      leadIds,
      targetOperatorId,
      mode,
    }: {
      leadIds: number[];
      targetOperatorId?: number;
      mode?: string;
    }) => {
      return api.post<{ total: number }>("/leads/bulk-reassign/", {
        lead_ids: leadIds,
        operator_id: targetOperatorId,
        mode: mode ?? (targetOperatorId ? undefined : "round_robin"),
      });
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["distribution-diagnostics"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      setIsReassigning(false);
      toast.success(`${res.data.total} ta kechagi lid muvaffaqiyatli boshqaga o'tkazildi!`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "O'tkazishda xatolik yuz berdi");
    },
  });

  const handleReassignYesterdayLeads = (mode: "round_robin" | "specific", targetId?: number) => {
    if (!selectedDetail?.yesterday_leads.length) return;
    const leadIds = selectedDetail.yesterday_leads.map((l) => l.id);
    if (mode === "round_robin") {
      if (confirm(`${leadIds.length} ta kechagi lid barcha faol operatorlarga teng taqsimlansinmi?`)) {
        bulkReassignMut.mutate({ leadIds, mode: "round_robin" });
      }
    } else if (targetId) {
      bulkReassignMut.mutate({ leadIds, targetOperatorId: targetId });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={1100}
      className="max-w-[96vw]"
    >
      <div className="flex flex-col gap-4 text-text">
        {/* Top Header Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border/40">
          <div>
            <h2 className="text-base font-bold flex items-center gap-2">
              <Activity className="w-5 h-5 text-accent" />
              <span>Operatorlar taqsimoti diagnostikasi</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-accent/15 text-accent font-medium">
                Real-time
              </span>
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Operator nima sababdan lid ololmayotganini (pauza, kechagi qoldiq, kvota, davomat) bir zumda tekshiring
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => diagQ.refetch()}
              disabled={diagQ.isFetching}
              title="Yangilash"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${diagQ.isFetching ? "animate-spin" : ""}`} />
              <span>Yangilash</span>
            </Button>
          </div>
        </div>

        {/* Global Summary KPI Pills */}
        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 text-xs">
            <div className="nf-card p-2.5 flex flex-col items-center justify-center text-center">
              <span className="text-muted text-[11px] font-medium flex items-center gap-1">
                <Users className="w-3 h-3" /> Jami
              </span>
              <span className="text-base font-bold mt-0.5">{summary.total_operators}</span>
            </div>

            <div className="nf-card p-2.5 flex flex-col items-center justify-center text-center bg-emerald-500/10 border-emerald-500/30">
              <span className="text-emerald-500 text-[11px] font-medium flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Ochiq (Tayyor)
              </span>
              <span className="text-base font-bold text-emerald-500 mt-0.5">
                {summary.eligible_count}
              </span>
            </div>

            <div className="nf-card p-2.5 flex flex-col items-center justify-center text-center bg-rose-500/10 border-rose-500/30">
              <span className="text-rose-500 text-[11px] font-medium flex items-center gap-1">
                <XCircle className="w-3 h-3" /> Bloklangan
              </span>
              <span className="text-base font-bold text-rose-500 mt-0.5">
                {summary.blocked_count}
              </span>
            </div>

            <div className="nf-card p-2.5 flex flex-col items-center justify-center text-center bg-amber-500/10 border-amber-500/30">
              <span className="text-amber-500 text-[11px] font-medium flex items-center gap-1">
                <Pause className="w-3 h-3" /> Pauzada
              </span>
              <span className="text-base font-bold text-amber-500 mt-0.5">
                {summary.paused_count}
              </span>
            </div>

            <div className="nf-card p-2.5 flex flex-col items-center justify-center text-center bg-orange-500/10 border-orange-500/30">
              <span className="text-orange-500 text-[11px] font-medium flex items-center gap-1">
                <Layers className="w-3 h-3" /> Kvota to'lgan (5/5)
              </span>
              <span className="text-base font-bold text-orange-500 mt-0.5">
                {summary.quota_full_count}
              </span>
            </div>

            <div className="nf-card p-2.5 flex flex-col items-center justify-center text-center bg-blue-500/10 border-blue-500/30">
              <span className="text-blue-500 text-[11px] font-medium flex items-center gap-1">
                <Activity className="w-3 h-3" /> Bo'sh lidlar puli
              </span>
              <span className="text-base font-bold text-blue-500 mt-0.5">
                {summary.orphans_count} ta
              </span>
            </div>
          </div>
        )}

        {/* Main Split Layout: Left Operator List / Right Detail Card */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 min-h-[460px]">
          {/* LEFT COLUMN: Operators List */}
          <div className="md:col-span-5 flex flex-col gap-2.5 border-r border-border/40 pr-0 md:pr-3">
            {/* Search Input */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Operator nomi yoki raqami..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full text-xs bg-bg/80 border border-border/60 rounded-xl pl-8 pr-3 py-2 text-text placeholder:text-muted focus:outline-none focus:border-accent"
              />
            </div>

            {/* Quick Filter Tabs */}
            <div className="flex items-center gap-1 overflow-x-auto pb-1 text-[11px]">
              <button
                type="button"
                onClick={() => setFilterTab("all")}
                className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                  filterTab === "all"
                    ? "bg-accent text-white"
                    : "bg-faint text-muted hover:text-text"
                }`}
              >
                Barchasi ({operators.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab("blocked")}
                className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                  filterTab === "blocked"
                    ? "bg-rose-500 text-white"
                    : "bg-faint text-muted hover:text-text"
                }`}
              >
                Bloklangan ({summary?.blocked_count ?? 0})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab("paused")}
                className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                  filterTab === "paused"
                    ? "bg-amber-500 text-white"
                    : "bg-faint text-muted hover:text-text"
                }`}
              >
                Pauza ({summary?.paused_count ?? 0})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab("eligible")}
                className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                  filterTab === "eligible"
                    ? "bg-emerald-500 text-white"
                    : "bg-faint text-muted hover:text-text"
                }`}
              >
                Ochiq ({summary?.eligible_count ?? 0})
              </button>
            </div>

            {/* Scrollable Operators List */}
            <div className="flex flex-col gap-1.5 max-h-[480px] overflow-y-auto nf-scroll-thin pr-1">
              {diagQ.isLoading ? (
                <div className="p-8 text-center text-xs text-muted">Yuklanmoqda...</div>
              ) : operators.length === 0 ? (
                <div className="p-8 text-center text-xs text-muted">Operatorlar topilmadi</div>
              ) : (
                operators.map((op) => {
                  const isSelected = op.id === effectiveSelectedId;
                  return (
                    <div
                      key={op.id}
                      onClick={() => setSelectedId(op.id)}
                      className={`p-2.5 rounded-xl border text-xs cursor-pointer transition-all ${
                        isSelected
                          ? "bg-accent/10 border-accent shadow-sm"
                          : "bg-bg/40 border-border/40 hover:bg-faint/60"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="font-semibold text-text truncate flex items-center gap-1.5">
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              op.eligible ? "bg-emerald-500" : "bg-rose-500"
                            }`}
                          />
                          <span className="truncate">{op.full_name}</span>
                        </div>

                        {op.is_paused ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-amber-500/20 text-amber-500 shrink-0">
                            Pauzada
                          </span>
                        ) : op.eligible ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-emerald-500/20 text-emerald-500 shrink-0">
                            Ochiq
                          </span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-rose-500/20 text-rose-500 shrink-0">
                            {op.working_count >= op.quota_limit
                              ? `Kvota ${op.working_count}/${op.quota_limit}`
                              : op.primary_blocker_title_uz}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between mt-1 text-[11px] text-muted">
                        <span>Kvota: {op.working_count}/{op.quota_limit}</span>
                        {op.yesterday_unclosed_count > 0 && (
                          <span className="text-amber-500 font-medium">
                            Kechadan: {op.yesterday_unclosed_count} ta
                          </span>
                        )}
                        <span>Bugun: {op.today_received_count} ta</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* RIGHT COLUMN: Detailed Diagnostic Card */}
          <div className="md:col-span-7 flex flex-col gap-3">
            {selectedOp ? (
              <div className="flex flex-col gap-3">
                {/* Operator Header Card */}
                <div className="nf-card p-3.5 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-bold text-text truncate">
                        {selectedOp.full_name}
                      </h3>
                      <span className="text-[11px] text-muted">ID: {selectedOp.id}</span>
                      {selectedOp.phone && (
                        <span className="text-[11px] text-muted flex items-center gap-0.5">
                          <Phone className="w-3 h-3" /> {selectedOp.phone}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted mt-0.5">
                      Oxirgi lid tushgan vaqt:{" "}
                      <span className="text-text font-medium">
                        {timeAgo(selectedOp.last_lead_assigned_at)}
                      </span>
                    </p>
                  </div>

                  {/* Actions buttons */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* Pause Toggle */}
                    <Button
                      variant={selectedOp.is_paused ? "primary" : "secondary"}
                      size="sm"
                      onClick={() =>
                        togglePauseMut.mutate({
                          opId: selectedOp.id,
                          currentlyPaused: selectedOp.is_paused,
                        })
                      }
                      disabled={togglePauseMut.isPending}
                    >
                      {selectedOp.is_paused ? (
                        <>
                          <Play className="w-3 h-3 text-emerald-400" />
                          <span>Pauzadan chiqarish</span>
                        </>
                      ) : (
                        <>
                          <Pause className="w-3 h-3 text-amber-400" />
                          <span>Pauzaga qo'yish</span>
                        </>
                      )}
                    </Button>

                    {/* Morning Gate Toggle */}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        toggleGateMut.mutate({
                          opId: selectedOp.id,
                          enableGate: !selectedOp.blocking_gate_enabled,
                        })
                      }
                      disabled={toggleGateMut.isPending}
                      title={
                        selectedOp.blocking_gate_enabled
                          ? "Geyt yoqilgan: kechagi lidlar yangi lid kelishini to'sadi"
                          : "Geyt o'chirilgan: kechagi lidlar bo'lsa ham yangi lid olaveradi"
                      }
                    >
                      {selectedOp.blocking_gate_enabled ? (
                        <>
                          <ShieldAlert className="w-3 h-3 text-amber-500" />
                          <span>Geyt: ON</span>
                        </>
                      ) : (
                        <>
                          <Shield className="w-3 h-3 text-muted" />
                          <span>Geyt: OFF</span>
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {/* Big Status Verdict Banner */}
                <div
                  className={`p-3.5 rounded-xl border text-xs flex flex-col gap-1.5 ${
                    selectedOp.eligible
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-500"
                      : "bg-rose-500/10 border-rose-500/30 text-rose-500"
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold text-sm">
                    {selectedOp.eligible ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        <span>LIDLAR TAQSIMOTI OCHIQ (Раздача открыта)</span>
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="w-4 h-4 text-rose-500" />
                        <span>LIDLAR TAQSIMOTI BLOKLANGAN (Раздача заблокирована)</span>
                      </>
                    )}
                  </div>

                  <div className="text-text font-normal space-y-1 pl-6">
                    {selectedOp.reasons_uz.map((reason, idx) => (
                      <div key={idx} className="flex items-start gap-1.5">
                        <span className="text-rose-500 font-bold">•</span>
                        <span>{reason}</span>
                      </div>
                    ))}
                    {selectedOp.yesterday_unclosed_count > 0 && !selectedOp.blocking_gate_enabled && (
                      <div className="flex items-start gap-1.5 text-amber-500 text-[11px] mt-1 pt-1 border-t border-border/30">
                        <span>ℹ️</span>
                        <span>
                          Eslatma: Kechadan qolgan {selectedOp.yesterday_unclosed_count} ta yopilmagan lidi bor (geyt o'chirilgani sababli bloklamayapti).
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Key Metrics Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div className="nf-card p-2.5">
                    <span className="text-muted text-[11px]">Joriy kvota</span>
                    <div className="text-sm font-bold text-text mt-0.5">
                      {selectedOp.working_count} / {selectedOp.quota_limit}
                    </div>
                  </div>

                  <div className="nf-card p-2.5">
                    <span className="text-muted text-[11px]">Kechagi qoldiq</span>
                    <div
                      className={`text-sm font-bold mt-0.5 ${
                        selectedOp.yesterday_unclosed_count > 0 ? "text-amber-500" : "text-text"
                      }`}
                    >
                      {selectedOp.yesterday_unclosed_count} ta
                    </div>
                  </div>

                  <div className="nf-card p-2.5">
                    <span className="text-muted text-[11px]">Bugun olgan</span>
                    <div className="text-sm font-bold text-text mt-0.5">
                      {selectedOp.today_received_count} ta
                    </div>
                  </div>

                  <div className="nf-card p-2.5">
                    <span className="text-muted text-[11px]">Bugungi qo'ng'iroq</span>
                    <div className="text-sm font-bold text-text mt-0.5">
                      {selectedOp.today_calls_count} ta
                    </div>
                  </div>
                </div>

                {/* Details Tab Navigation */}
                <div className="flex items-center justify-between border-b border-border/40 pt-1">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveDetailTab("yesterday")}
                      className={`pb-2 text-xs font-semibold border-b-2 transition-colors ${
                        activeDetailTab === "yesterday"
                          ? "border-accent text-accent"
                          : "border-transparent text-muted hover:text-text"
                      }`}
                    >
                      ⏳ Kechagi qoldiq lidlar ({selectedDetail?.yesterday_leads.length ?? 0})
                    </button>

                    <button
                      type="button"
                      onClick={() => setActiveDetailTab("working")}
                      className={`pb-2 text-xs font-semibold border-b-2 transition-colors ${
                        activeDetailTab === "working"
                          ? "border-accent text-accent"
                          : "border-transparent text-muted hover:text-text"
                      }`}
                    >
                      📦 Joriy kvotadagi lidlar ({selectedDetail?.working_leads.length ?? 0})
                    </button>

                    <button
                      type="button"
                      onClick={() => setActiveDetailTab("recent")}
                      className={`pb-2 text-xs font-semibold border-b-2 transition-colors ${
                        activeDetailTab === "recent"
                          ? "border-accent text-accent"
                          : "border-transparent text-muted hover:text-text"
                      }`}
                    >
                      📜 Bugun berilganlar ({selectedDetail?.recent_assignments.length ?? 0})
                    </button>
                  </div>

                  {activeDetailTab === "yesterday" && selectedDetail?.yesterday_leads.length ? (
                    <div className="pb-1.5 flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleReassignYesterdayLeads("round_robin")}
                        disabled={bulkReassignMut.isPending}
                        title="Ushbu operatorning barcha kechagi qoldiq lidlarini boshqa faol operatorlarga teng taqsimlash"
                      >
                        <RefreshCw className="w-3 h-3 text-accent" />
                        <span>Barchaga teng taqsimlash</span>
                      </Button>
                    </div>
                  ) : null}
                </div>

                {/* Tab 1: Yesterday's Unclosed Leads */}
                {activeDetailTab === "yesterday" && (
                  <div className="flex flex-col gap-2 max-h-[260px] overflow-y-auto nf-scroll-thin">
                    {!selectedDetail?.yesterday_leads.length ? (
                      <div className="p-6 text-center text-xs text-muted">
                        Kechadan qolgan yopilmagan lidlar yo'q. Hammasi toza!
                      </div>
                    ) : (
                      selectedDetail.yesterday_leads.map((lead) => (
                        <div
                          key={lead.id}
                          className="p-2 rounded-xl bg-bg/60 border border-border/40 text-xs flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 font-medium text-text truncate">
                              <span className="text-muted text-[11px]">#{lead.id}</span>
                              <span className="truncate">{lead.full_name || "Mijoz"}</span>
                              <span className="text-muted text-[11px] font-mono">{lead.phone}</span>
                            </div>
                            <div className="flex items-center gap-2 text-[11px] text-muted mt-0.5">
                              <span className="px-1.5 py-0.2 rounded bg-faint text-text font-medium">
                                {lead.status_label_uz || lead.status}
                              </span>
                              <span>
                                {lead.days_ago ? `${lead.days_ago} kun oldin` : "Kechagi"}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <a
                              href={`/leads?search=${encodeURIComponent(lead.phone)}`}
                              target="_blank"
                              rel="noreferrer"
                              className="p-1 rounded hover:bg-faint text-muted hover:text-text transition-colors"
                              title="Lidni ochish"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* Tab 2: Working Quota Leads */}
                {activeDetailTab === "working" && (
                  <div className="flex flex-col gap-2 max-h-[260px] overflow-y-auto nf-scroll-thin">
                    {!selectedDetail?.working_leads.length ? (
                      <div className="p-6 text-center text-xs text-muted">
                        Hozirda kvotani to'ldirib turgan faol lidlar yo'q.
                      </div>
                    ) : (
                      selectedDetail.working_leads.map((lead) => (
                        <div
                          key={lead.id}
                          className="p-2 rounded-xl bg-bg/60 border border-border/40 text-xs flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 font-medium text-text truncate">
                              <span className="text-muted text-[11px]">#{lead.id}</span>
                              <span className="truncate">{lead.full_name || "Mijoz"}</span>
                              <span className="text-muted text-[11px] font-mono">{lead.phone}</span>
                            </div>
                            <div className="flex items-center gap-2 text-[11px] text-muted mt-0.5">
                              <span className="px-1.5 py-0.2 rounded bg-accent/15 text-accent font-medium">
                                {lead.status_label_uz || lead.status}
                              </span>
                              <span>
                                {lead.hours_since_update ? `≈ ${lead.hours_since_update} soatdan beri` : "Yaqinda"}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <a
                              href={`/leads?search=${encodeURIComponent(lead.phone)}`}
                              target="_blank"
                              rel="noreferrer"
                              className="p-1 rounded hover:bg-faint text-muted hover:text-text transition-colors"
                              title="Lidni ochish"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* Tab 3: Recent Delivered Leads */}
                {activeDetailTab === "recent" && (
                  <div className="flex flex-col gap-2 max-h-[260px] overflow-y-auto nf-scroll-thin">
                    {!selectedDetail?.recent_assignments.length ? (
                      <div className="p-6 text-center text-xs text-muted">
                        Bugun avtotizim orqali lid berilmagan.
                      </div>
                    ) : (
                      selectedDetail.recent_assignments.map((item) => (
                        <div
                          key={item.assignment_id}
                          className="p-2 rounded-xl bg-bg/60 border border-border/40 text-xs flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-text truncate">
                              #{item.lead_id} {item.lead_name}
                            </div>
                            <div className="text-[11px] text-muted mt-0.5 flex items-center gap-2">
                              <span className="px-1.5 py-0.2 rounded bg-faint text-muted">
                                {item.source}
                              </span>
                              <span>{timeAgo(item.created_at)}</span>
                            </div>
                          </div>

                          <a
                            href={`/leads?search=${item.lead_id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="p-1 rounded hover:bg-faint text-muted hover:text-text"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="p-12 text-center text-xs text-muted">
                Tafsilotlarni ko'rish uchun chap tomondan operatorni tanlang
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
