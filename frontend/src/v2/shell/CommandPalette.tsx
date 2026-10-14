import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search, User, Receipt, Phone, CornerDownLeft } from "lucide-react";
import { api } from "../../lib/api";
import { useTheme } from "../../store/theme";
import { useT2 } from "../i18n";
import { useCommandPalette } from "./commandStore";
import { useNavGroups } from "./SideNav";

interface Hit {
  key: string;
  group: string;
  title: string;
  sub?: string;
  icon: "page" | "lead" | "sale" | "operator";
  go: string;
}

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = window.setTimeout(() => setD(v), ms);
    return () => window.clearTimeout(id);
  }, [v, ms]);
  return d;
}

const ICONS = { page: CornerDownLeft, lead: Phone, sale: Receipt, operator: User };

export function CommandPalette() {
  const { isOpen, open, close } = useCommandPalette();
  const t = useT2();
  const nav = useNavigate();
  const theme = useTheme((s) => s.theme);
  const { groups, kind } = useNavGroups();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dq = useDebounced(q.trim());
  const digits = dq.replace(/\D/g, "");
  const isManager = kind !== "operator";

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (useCommandPalette.getState().isOpen) close();
        else open();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, close]);

  useEffect(() => {
    if (isOpen) {
      setQ("");
      setSel(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  const leads = useQuery({
    queryKey: ["v2-cmd", "leads", digits],
    queryFn: () =>
      api.get<Array<{ id: number; full_name: string; phone: string; status?: string; operator_name?: string }> | { results: Array<{ id: number; full_name: string; phone: string; status?: string; operator_name?: string }> }>(
        `/leads/phone-search/?q=${encodeURIComponent(digits)}`,
      ).then((r) => (Array.isArray(r.data) ? r.data : r.data.results ?? [])),
    enabled: isOpen && digits.length >= 4,
    staleTime: 30_000,
  });
  const sales = useQuery({
    queryKey: ["v2-cmd", "sales", dq],
    queryFn: () =>
      api.get<{ results: Array<{ id: number; phone_model?: string; imei?: string; total_amount?: string | number; operator_name?: string }> }>(
        `/sales/?search=${encodeURIComponent(dq)}&limit=5`,
      ).then((r) => r.data.results ?? []),
    enabled: isOpen && isManager && dq.length >= 3,
    staleTime: 30_000,
  });
  const operators = useQuery({
    queryKey: ["v2-cmd", "operators", dq],
    queryFn: () =>
      api.get<Array<{ id: number; full_name: string; phone?: string }> | { results: Array<{ id: number; full_name: string; phone?: string }> }>(
        `/operators/?search=${encodeURIComponent(dq)}`,
      ).then((r) => (Array.isArray(r.data) ? r.data : r.data.results ?? []).slice(0, 5)),
    enabled: isOpen && isManager && dq.length >= 2 && digits.length < 4,
    staleTime: 30_000,
  });

  const hits: Hit[] = useMemo(() => {
    const out: Hit[] = [];
    const needle = q.trim().toLowerCase();
    const pages = groups.flatMap((g) => g.items).filter((x) => !x.external);
    for (const p of pages) {
      const label = t(p.label);
      if (!needle || label.toLowerCase().includes(needle)) out.push({ key: "p" + p.id, group: t("v2.cmd.pages"), title: label, icon: "page", go: p.to });
    }
    const pageHits = needle ? out : out.slice(0, 8);
    const rest: Hit[] = [];
    for (const l of leads.data ?? []) rest.push({ key: "l" + l.id, group: t("v2.cmd.leads"), title: l.full_name || l.phone, sub: [l.phone, l.operator_name].filter(Boolean).join(" · "), icon: "lead", go: isManager ? `/leads?search=${encodeURIComponent(l.phone)}` : `/my?lead=${l.id}` });
    for (const s of sales.data ?? []) rest.push({ key: "s" + s.id, group: t("v2.cmd.sales"), title: `№${s.id} · ${s.phone_model ?? ""}`, sub: [s.imei, s.operator_name].filter(Boolean).join(" · "), icon: "sale", go: `/sales/${s.id}` });
    for (const o of operators.data ?? []) rest.push({ key: "o" + o.id, group: t("v2.cmd.operators"), title: o.full_name, sub: o.phone, icon: "operator", go: `/operators/${o.id}` });
    return [...rest, ...pageHits];
  }, [q, groups, leads.data, sales.data, operators.data, isManager, t]);

  useEffect(() => setSel(0), [q]);

  if (!isOpen) return null;
  const go = (h?: Hit) => {
    if (!h) return;
    close();
    nav(h.go);
  };
  let lastGroup = "";
  return createPortal(
    <div className="nf" data-theme={theme} style={{ position: "fixed", inset: 0, zIndex: 70, background: "transparent" }}>
      <div className="scrim" onClick={close} />
      <div style={{ position: "absolute", left: 0, right: 0, top: "12vh", display: "flex", justifyContent: "center", padding: "0 16px", pointerEvents: "none" }}>
        <section className="palette" role="dialog" aria-modal="true" style={{ width: 640, maxWidth: "100%", pointerEvents: "auto" }}>
          <div className="row g8" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
            <Search className="ic c3" />
            <input
              ref={inputRef}
              className="grow"
              style={{ border: 0, outline: 0, background: "transparent", fontSize: 16, color: "var(--ink)", minWidth: 0 }}
              placeholder={t("v2.cmd.placeholder")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") close();
                if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
                if (e.key === "Enter") go(hits[sel]);
              }}
            />
            <span className="kbd">Esc</span>
          </div>
          <div style={{ maxHeight: "55vh", overflow: "auto", padding: "6px 0" }}>
            {digits.length > 0 && digits.length < 4 ? <div className="xs c3" style={{ padding: "6px 16px" }}>{t("v2.cmd.minPhone")}</div> : null}
            {hits.length === 0 ? <div className="s c3" style={{ padding: "16px" }}>{t("v2.cmd.nothing")}</div> : null}
            {hits.map((h, i) => {
              const Icon = ICONS[h.icon];
              const header = h.group !== lastGroup ? (lastGroup = h.group) : null;
              return (
                <div key={h.key}>
                  {header ? <div className="lbl" style={{ padding: "10px 16px 4px" }}>{header}</div> : null}
                  <button
                    type="button"
                    className={`li${i === sel ? " is-sel" : ""}`}
                    style={{ width: "100%", border: 0, textAlign: "left", background: i === sel ? "var(--brand-soft)" : "transparent", minHeight: 44, cursor: "pointer" }}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => go(h)}
                  >
                    <Icon className="ic c3" />
                    <span className="col grow" style={{ minWidth: 0 }}>
                      <span className="s w6 trunc">{h.title}</span>
                      {h.sub ? <span className="xs c3 num trunc">{h.sub}</span> : null}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="xs c3" style={{ padding: "8px 16px", borderTop: "1px solid var(--line)" }}>{t("v2.cmd.hint")}</div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
