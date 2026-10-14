import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, RefreshCw, Settings2, Users } from "lucide-react";
import { api } from "../../lib/api";
import { Button, toast } from "../ui";
import {
  SheetSyncDiagnosticsModal,
  type SheetHealthOverview,
} from "./SheetSyncDiagnosticsModal";
import { OperatorDiagnosticsModal } from "../operators/OperatorDiagnosticsModal";

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "Hech qachon";
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 10) return "Hozirgina";
  if (sec < 60) return `${sec}s oldin`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m oldin`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h oldin`;
  return `${Math.floor(hr / 24)}d oldin`;
}

export function SheetSyncBar() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [opDiagOpen, setOpDiagOpen] = useState(false);

  const overviewQ = useQuery<SheetHealthOverview>({
    queryKey: ["sheet-health-overview"],
    queryFn: () => api.get<SheetHealthOverview>("/sheet-sources/health-overview/").then((r) => r.data),
    refetchInterval: 30_000,
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

  const d = overviewQ.data;
  if (!d || d.total_active_sources === 0) return null;

  const hasErrors = !d.overall_healthy;
  const errorCount = d.sources.filter((s) => !s.is_healthy).length;

  return (
    <>
      <div
        className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl border transition animate-nfFadeUp"
        style={{
          background: hasErrors ? "rgba(239,68,68,0.06)" : "var(--surface)",
          borderColor: hasErrors ? "rgba(239,68,68,0.25)" : "var(--border)",
        }}
      >
        <div className="flex items-center gap-2.5 text-[12.5px] min-w-0">
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{
              background: hasErrors ? "#ef4444" : "#10b981",
              boxShadow: hasErrors ? "0 0 8px rgba(239,68,68,0.6)" : "0 0 8px rgba(16,185,129,0.5)",
            }}
          />

          <span className="font-semibold text-text">Google Sheets:</span>

          {hasErrors ? (
            <span className="text-danger font-medium flex items-center gap-1 truncate">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {errorCount} ta jadvalda xatolik aniqlandi!
            </span>
          ) : (
            <span className="text-muted truncate">
              {d.total_active_sources} ta jadval aloqada · So'nggi tekshiruv:{" "}
              <strong className="text-text font-medium">{timeAgo(d.latest_sync_at)}</strong> · Yozish (Writeback):{" "}
              <strong className="text-text font-medium">{d.writeback.pending_count} navbatda</strong>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            onClick={() => syncAllMut.mutate()}
            disabled={syncAllMut.isPending}
            className="!py-1 !px-2.5 !text-[12px]"
          >
            <RefreshCw className={`w-3 h-3 mr-1.5 ${syncAllMut.isPending ? "animate-spin" : ""}`} />
            {syncAllMut.isPending ? "O'qilmoqda…" : "Hozir tekshirish"}
          </Button>

          <Button
            variant="secondary"
            onClick={() => setModalOpen(true)}
            className="!py-1 !px-2.5 !text-[12px]"
          >
            <Activity className="w-3 h-3 mr-1.5 text-accent" />
            Jadvallar
          </Button>

          <Button
            variant="secondary"
            onClick={() => setOpDiagOpen(true)}
            className="!py-1 !px-2.5 !text-[12px]"
          >
            <Users className="w-3 h-3 mr-1.5 text-accent" />
            Operatorlar
          </Button>
        </div>
      </div>

      <SheetSyncDiagnosticsModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />

      <OperatorDiagnosticsModal
        open={opDiagOpen}
        onClose={() => setOpDiagOpen(false)}
      />
    </>
  );
}
