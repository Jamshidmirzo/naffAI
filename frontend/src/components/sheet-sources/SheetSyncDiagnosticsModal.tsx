import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  Send,
  Table,
} from "lucide-react";
import { api } from "../../lib/api";
import { Button, Modal, StatusBadge, toast } from "../ui";
import { useT } from "../../lib/i18n";

export interface SheetSourceHealthItem {
  id: number;
  name: string;
  worksheet_name: string;
  spreadsheet_id: string;
  gid: number;
  active: boolean;
  last_synced_at: string | null;
  last_synced_ago_seconds: number | null;
  last_synced_row: number;
  last_sync_error: string | null;
  is_healthy: boolean;
  writeback_enabled: boolean;
  writeback_status_col: string;
  writeback_operator_col: string;
  leads_today: number;
  leads_total: number;
}

export interface SheetHealthOverview {
  overall_healthy: boolean;
  total_active_sources: number;
  latest_sync_at: string | null;
  sources: SheetSourceHealthItem[];
  writeback: {
    is_healthy: boolean;
    pending_count: number;
    failed_count: number;
    done_last_1h: number;
    failed_samples: Array<{ lead_id: number; last_error: string; attempts: number }>;
  };
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
}

export function SheetSyncDiagnosticsModal({ open, onClose }: Props) {
  const qc = useQueryClient();
  const t = useT();

  const [rescanTarget, setRescanTarget] = useState<number | null>(null);

  const overviewQ = useQuery<SheetHealthOverview>({
    queryKey: ["sheet-health-overview"],
    queryFn: () => api.get<SheetHealthOverview>("/sheet-sources/health-overview/").then((r) => r.data),
    enabled: open,
    refetchInterval: open ? 10_000 : false,
  });

  const syncAllMut = useMutation({
    mutationFn: () => api.post("/sheet-sources/sync-all/").then((r) => r.data),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["sheet-health-overview"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["sheet-sources"] });
      toast.success(
        `Tekshirildi: ${data.total_sources} ta jadval, ${data.total_read} qator o'qildi, yangi lidlar: ${data.total_created}`
      );
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || "Sinxronlashda xatolik yuz berdi");
    },
  });

  const flushWritebackMut = useMutation({
    mutationFn: () => api.post("/sheet-sources/flush-writebacks/").then((r) => r.data),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["sheet-health-overview"] });
      toast.success(
        `Yozish navbati bajarildi: ${data.stats?.ok ?? 0} ta muvaffaqiyatli, qolgan navbat: ${data.remaining_pending ?? 0}`
      );
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || "Yozishda xatolik yuz berdi");
    },
  });

  const syncSingleMut = useMutation({
    mutationFn: (id: number) => api.post(`/sheet-sources/${id}/sync-now/`, { force: true }).then((r) => r.data),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["sheet-health-overview"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success(
        `Jadval o'qildi: ${data.read ?? 0} qator, yangi: ${data.created ?? 0}, birlashtirildi: ${data.merged ?? 0}`
      );
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || "O'qishda xatolik");
    },
  });

  const rescanMut = useMutation({
    mutationFn: (id: number) => api.post(`/sheet-sources/${id}/reset-watermark/`, { row: 0 }).then((r) => r.data),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["sheet-health-overview"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      setRescanTarget(null);
      toast.success(
        `Qayta to'liq o'qildi: ${data.read ?? 0} qator, yangi: ${data.created ?? 0}, birlashtirildi: ${data.merged ?? 0}`
      );
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || "Qayta o'qishda xatolik");
    },
  });

  const d = overviewQ.data;

  return (
    <Modal open={open} onClose={onClose} width={780}>
      <div className="p-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[color:var(--border)]">
          <div className="flex items-center gap-3">
            <div
              className="grid place-items-center text-white"
              style={{
                width: 36,
                height: 36,
                borderRadius: 12,
                background: d?.overall_healthy ? "linear-gradient(135deg, #10b981, #059669)" : "linear-gradient(135deg, #ef4444, #dc2626)",
              }}
            >
              {d?.overall_healthy ? <CheckCircle2 className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
            </div>
            <div>
              <div className="text-[17px] font-semibold tracking-tight">
                Google Sheets va Yozish (Writeback) diagnostikasi
              </div>
              <div className="text-[12.5px] text-muted">
                Lidlar kelishi va statuslar jadvalga yozilishini tekshirish
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => syncAllMut.mutate()}
              disabled={syncAllMut.isPending}
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${syncAllMut.isPending ? "animate-spin" : ""}`} />
              {syncAllMut.isPending ? "O'qilmoqda…" : "Hozir hammasini tekshirish"}
            </Button>
          </div>
        </div>

        {/* Global Summary KPI Bar */}
        {d && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="nf-card p-3.5 flex flex-col justify-between">
              <div className="flex items-center justify-between text-muted text-[11.5px] font-semibold uppercase tracking-wider">
                <span>Jadvallar</span>
                <Table className="w-3.5 h-3.5 text-muted" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-[20px] font-bold tabular-nums">{d.total_active_sources} ta faol</span>
                <span className="text-[12px] text-muted">({d.sources.filter((s) => s.is_healthy).length} sog'lom)</span>
              </div>
              <div className="mt-1 text-[11.5px] text-muted">
                So'nggi tekshiruv: <strong className="text-text">{timeAgo(d.latest_sync_at)}</strong>
              </div>
            </div>

            <div className="nf-card p-3.5 flex flex-col justify-between">
              <div className="flex items-center justify-between text-muted text-[11.5px] font-semibold uppercase tracking-wider">
                <span>Jadvalga yozish</span>
                <Send className="w-3.5 h-3.5 text-muted" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-[20px] font-bold tabular-nums">
                  {d.writeback.pending_count} ta navbatda
                </span>
                {d.writeback.failed_count > 0 && (
                  <span className="text-[12px] font-semibold text-danger">
                    ({d.writeback.failed_count} xato)
                  </span>
                )}
              </div>
              <div className="mt-1 text-[11.5px] text-muted flex items-center justify-between">
                <span>So'nggi 1 soatda: {d.writeback.done_last_1h} ta</span>
                {d.writeback.pending_count > 0 && (
                  <button
                    onClick={() => flushWritebackMut.mutate()}
                    disabled={flushWritebackMut.isPending}
                    className="text-[11px] font-semibold text-accent hover:underline"
                  >
                    Hozir yozish
                  </button>
                )}
              </div>
            </div>

            <div className="nf-card p-3.5 flex flex-col justify-between">
              <div className="flex items-center justify-between text-muted text-[11.5px] font-semibold uppercase tracking-wider">
                <span>Umumiy holat</span>
                <Activity className="w-3.5 h-3.5 text-muted" />
              </div>
              <div className="mt-2 flex items-center gap-2">
                {d.overall_healthy ? (
                  <span className="nf-badge" style={{ background: "rgba(16,185,129,.12)", color: "#10b981", borderColor: "rgba(16,185,129,.3)" }}>
                    Barchasi alo darajada
                  </span>
                ) : (
                  <StatusBadge tone="danger">Xatolik aniqlandi</StatusBadge>
                )}
              </div>
              <div className="mt-1 text-[11.5px] text-muted">
                Har 5 daqiqada avtomatik tekshiriladi
              </div>
            </div>
          </div>
        )}

        {/* Sources List */}
        <div className="mt-5">
          <div className="text-[13px] font-semibold text-muted uppercase tracking-wider mb-2.5">
            Ulangan Google Jadvallar ro'yxati
          </div>

          {overviewQ.isLoading ? (
            <div className="text-center py-10 text-muted text-[13px]">Jadvallar ma'lumotlari yuklanmoqda…</div>
          ) : !d || d.sources.length === 0 ? (
            <div className="text-center py-10 text-muted text-[13px]">Faol jadvallar topilmadi.</div>
          ) : (
            <div className="flex flex-col gap-2.5 max-h-[380px] overflow-y-auto nf-scroll-thin pr-1">
              {d.sources.map((s) => {
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${s.spreadsheet_id}/edit#gid=${s.gid}`;
                return (
                  <div
                    key={s.id}
                    className="p-3.5 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] hover:border-[color:var(--accent)] transition flex flex-col gap-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{
                            background: s.is_healthy ? "#10b981" : "#ef4444",
                            boxShadow: s.is_healthy ? "0 0 8px rgba(16,185,129,.4)" : "0 0 8px rgba(239,68,68,.4)",
                          }}
                        />
                        <span className="font-semibold text-[13.5px] truncate">{s.name}</span>
                        <span className="text-[12px] text-muted truncate">({s.worksheet_name || `gid: ${s.gid}`})</span>
                        <a
                          href={sheetUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-muted hover:text-text transition shrink-0"
                          title="Google Sheetni ochish"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          variant="ghost"
                          onClick={() => syncSingleMut.mutate(s.id)}
                          disabled={syncSingleMut.isPending}
                          className="!py-1 !px-2.5 !text-[12px]"
                        >
                          <RefreshCw className="w-3 h-3 mr-1" />
                          Tekshirish
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => rescanMut.mutate(s.id)}
                          disabled={rescanMut.isPending}
                          className="!py-1 !px-2.5 !text-[12px]"
                          title="1-qatordan boshlab qayta skanerlash"
                        >
                          <RotateCcw className="w-3 h-3 mr-1" />
                          Qayta o'qish
                        </Button>
                      </div>
                    </div>

                    {/* Metadata line */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
                      <div>
                        So'nggi tekshiruv: <strong className="text-text">{timeAgo(s.last_synced_at)}</strong>
                      </div>
                      <div>
                        Oxirgi qator: <strong className="text-text tabular-nums">{s.last_synced_row}</strong>
                      </div>
                      <div>
                        Bugungi lidlar: <strong className="text-text tabular-nums">{s.leads_today}</strong> (jami {s.leads_total})
                      </div>
                      <div>
                        Writeback:{" "}
                        {s.writeback_enabled ? (
                          <span className="text-good font-medium">
                            Faol ({s.writeback_status_col || "D"}, {s.writeback_operator_col || "E"})
                          </span>
                        ) : (
                          <span className="text-muted">O'chirilgan</span>
                        )}
                      </div>
                    </div>

                    {/* Error inline alert if any */}
                    {s.last_sync_error && (
                      <div
                        className="p-2.5 rounded-lg text-[12px] flex items-start gap-2 mt-1"
                        style={{
                          background: "rgba(239, 68, 68, 0.1)",
                          color: "var(--danger)",
                          border: "1px solid rgba(239, 68, 68, 0.25)",
                        }}
                      >
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <strong>Xatolik:</strong> {s.last_sync_error}
                          <div className="mt-1 text-[11px] opacity-90">
                            Maslahat: Google Sheetda ustunlar nomi o'zgargan bo'lishi mumkin. /sheet-sources bo'limida sozlamalarni tekshiring.
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Close Button */}
        <div className="mt-6 pt-3 border-t border-[color:var(--border)] flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Yopish
          </Button>
        </div>
      </div>
    </Modal>
  );
}
