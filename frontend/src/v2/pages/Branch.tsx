import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckSquare, MoreHorizontal, Plus, Search, Users as UsersIcon, X } from "lucide-react";
import { toast } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { useAuth } from "../../store/auth";
import { useT2 } from "../i18n";
import { Dialog, ErrorState, LoadingBlock, PageHeader, cx, fmtMln, fmtNum, useConfirm } from "../ui";
import {
  barCls,
  errText,
  initials,
  isManagerRole,
  planOf,
  pluralKey,
  toNum,
  useBranchOperators,
  useBranchUsers,
  useBulkMoveOperators,
  useCreateManager,
  useDeleteManager,
  useMoveOperator,
  usePromoteManager,
  useResetManagerPassword,
  userDisplayName,
  type BranchOperator,
  type BranchUser,
  type Creds,
} from "../api/branch";

/**
 * /team/managers — «Доска ветки» (super_manager / superadmin).
 * Columns: one per manager (+team_lead, shown as «Менеджер»), «Мои прямые»
 * (managed_by = me), owners outside the manager list, «Без менеджера».
 * Operators move by drag & drop (confirm first), by multi-select bulk bar,
 * or from the manager's team window (old MyManagers parity).
 */

type ColKey = number | "none";
type ColKind = "manager" | "direct" | "other" | "none";

interface Col {
  key: ColKey;
  kind: ColKind;
  user?: BranchUser;
  name: string;
  ini: string;
  ops: BranchOperator[];
}

interface PendingMove {
  op: BranchOperator;
  from: ColKey;
  to: ColKey;
}

const keyToManagerId = (k: ColKey): number | null => (k === "none" ? null : k);

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Ultra-light 9-digit UZ phone helpers (input shows «93 555 33 11»). */
function digits9(v: string) {
  let d = v.replace(/\D/g, "");
  if (d.startsWith("998") && d.length > 9) d = d.slice(3);
  return d.slice(0, 9);
}
function fmtPhone9(d: string) {
  const parts = [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean);
  return parts.join(" ");
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark style={{ background: "var(--warn-bg)", color: "inherit", borderRadius: 3 }}>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** Small anchored menu (column «⋯»). Closes on outside click / Esc. */
function ColumnMenu({ label, items }: { label: string; items: { label: string; danger?: boolean; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal className="ic" />
      </button>
      {open ? (
        <div className="card col" role="menu" style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", width: 240, zIndex: 20, boxShadow: "var(--shadow)", overflow: "hidden" }}>
          {items.map((it) => (
            <button
              key={it.label}
              className="li"
              role="menuitem"
              type="button"
              style={{ minHeight: 44, borderLeft: 0, borderRight: 0, borderTop: 0, background: "none", textAlign: "left", width: "100%", cursor: "pointer" }}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              <span className={cx("s grow", it.danger && "c-bad")}>{it.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function Branch() {
  const t = useT2();
  const nav = useNavigate();
  const meUsername = useAuth((s) => s.username);
  const confirm = useConfirm();

  const usersQ = useBranchUsers();
  const opsQ = useBranchOperators();
  const moveMut = useMoveOperator();
  const bulkMut = useBulkMoveOperators();
  const promoteMut = usePromoteManager();
  const createMut = useCreateManager();
  const resetMut = useResetManagerPassword();
  const deleteMut = useDeleteManager();

  const [search, setSearch] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkTarget, setBulkTarget] = useState<string>("");
  const [drag, setDrag] = useState<{ opId: number; from: ColKey } | null>(null);
  const [over, setOver] = useState<ColKey | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [failedId, setFailedId] = useState<number | null>(null);
  const [teamOf, setTeamOf] = useState<BranchUser | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [creds, setCreds] = useState<(Creds & { kind: "created" | "reset"; name: string }) | null>(null);

  useEffect(() => {
    if (failedId == null) return;
    const id = window.setTimeout(() => setFailedId(null), 5000);
    return () => window.clearTimeout(id);
  }, [failedId]);

  const users = usersQ.data ?? [];
  const ops = opsQ.data ?? [];
  const me = useMemo(() => users.find((u) => u.username === meUsername) ?? null, [users, meUsername]);
  const meId = me?.id ?? null;
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  const managers = useMemo(
    () => users.filter((u) => u.username !== meUsername && isManagerRole(u.role)),
    [users, meUsername],
  );

  const cols: Col[] = useMemo(() => {
    const by = new Map<ColKey, BranchOperator[]>();
    for (const o of ops) {
      const k: ColKey = o.managed_by_id ?? "none";
      const arr = by.get(k) ?? [];
      arr.push(o);
      by.set(k, arr);
    }
    const sortOps = (arr: BranchOperator[]) =>
      [...arr].sort((a, b) => {
        const ia = a.status === "inactive" ? 1 : 0;
        const ib = b.status === "inactive" ? 1 : 0;
        if (ia !== ib) return ia - ib;
        return toNum(b.plan_actual) - toNum(a.plan_actual) || a.full_name.localeCompare(b.full_name);
      });
    const out: Col[] = managers.map((m) => {
      const name = userDisplayName(m);
      return { key: m.id, kind: "manager", user: m, name, ini: initials(name), ops: sortOps(by.get(m.id) ?? []) };
    });
    const known = new Set<ColKey>(managers.map((m) => m.id));
    if (meId != null) {
      known.add(meId);
      out.push({ key: meId, kind: "direct", user: me ?? undefined, name: t("v2.branch.direct"), ini: initials(me ? userDisplayName(me) : "?"), ops: sortOps(by.get(meId) ?? []) });
    }
    for (const [k, arr] of by) {
      if (k === "none" || known.has(k)) continue;
      const u = userById.get(k);
      const name = u ? userDisplayName(u) : `#${k}`;
      out.push({ key: k, kind: "other", user: u, name, ini: initials(name), ops: sortOps(arr) });
    }
    out.push({ key: "none", kind: "none", name: t("v2.branch.none"), ini: "—", ops: sortOps(by.get("none") ?? []) });
    return out;
  }, [ops, managers, meId, me, userById, t]);

  const colByKey = useMemo(() => new Map(cols.map((c) => [c.key, c])), [cols]);
  const opById = useMemo(() => new Map(ops.map((o) => [o.id, o])), [ops]);

  const q = search.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, "");
  const matches = (o: BranchOperator) =>
    !q || o.full_name.toLowerCase().includes(q) || (qDigits.length >= 2 && (o.phone ?? "").replace(/\D/g, "").includes(qDigits));
  const matchCount = q ? ops.filter(matches).length : 0;

  const opsWord = (n: number) => t(pluralKey("v2.branch.ops", n), { n });

  /* ---------------- moving ---------------- */

  const targetLabel = (to: ColKey) => {
    const c = colByKey.get(to);
    return c?.name ?? "";
  };

  function doMove(op: BranchOperator, from: ColKey, to: ColKey, isUndo = false) {
    const toCol = colByKey.get(to);
    moveMut.mutate(
      { opId: op.id, managerId: keyToManagerId(to) },
      {
        onSuccess: () => {
          setFailedId(null);
          const msg =
            to === "none"
              ? t("v2.branch.movedNone", { op: op.full_name })
              : toCol?.kind === "direct"
                ? t("v2.branch.movedDirect", { op: op.full_name })
                : t("v2.branch.moved", { op: op.full_name, to: targetLabel(to) });
          if (isUndo) toast.success(msg);
          else toast.success(msg, { action: { label: t("v2.branch.undo"), onClick: () => doMove(op, to, from, true) } });
        },
        onError: (e) => {
          setFailedId(op.id);
          toast.error(t("v2.branch.moveFailed", { op: op.full_name, err: errText(e, t("v2.branch.noAnswer")) }), {
            duration: 8000,
            action: { label: t("v2.state.retry"), onClick: () => doMove(op, from, to, isUndo) },
          });
        },
      },
    );
  }

  const onCardDragStart = (e: DragEvent, op: BranchOperator, from: ColKey) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(op.id));
    setDrag({ opId: op.id, from });
  };
  const onColDragOver = (e: DragEvent, key: ColKey) => {
    if (!drag || drag.from === key) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (over !== key) setOver(key);
  };
  const onColDragLeave = (e: DragEvent, key: ColKey) => {
    const next = e.relatedTarget as Node | null;
    if (next && (e.currentTarget as HTMLElement).contains(next)) return;
    if (over === key) setOver(null);
  };
  const onColDrop = (e: DragEvent, key: ColKey) => {
    e.preventDefault();
    const d = drag;
    setDrag(null);
    setOver(null);
    if (!d || d.from === key) return;
    const op = opById.get(d.opId);
    if (op) setPending({ op, from: d.from, to: key });
  };

  const pendingTitle = (p: PendingMove) => {
    const toCol = colByKey.get(p.to);
    if (p.to === "none") return t("v2.branch.moveQNone", { op: p.op.full_name });
    if (toCol?.kind === "direct") return t("v2.branch.moveQDirect", { op: p.op.full_name });
    return t("v2.branch.moveQ", { op: p.op.full_name, to: targetLabel(p.to) });
  };
  const pendingBody = (p: PendingMove) => {
    const fromCol = colByKey.get(p.from);
    const parts = [t("v2.branch.moveBody")];
    if (fromCol && (fromCol.kind === "manager" || fromCol.kind === "other")) parts.push(t("v2.branch.moveBodyFrom", { from: fromCol.name }));
    if (p.to === "none") parts.push(t("v2.branch.moveBodyNone"));
    return parts.join(" ");
  };

  /* ---------------- selection / bulk ---------------- */

  const toggleSel = (id: number) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const clearSel = () => {
    setSelected(new Set());
    setBulkTarget("");
  };
  const runBulk = () => {
    if (!bulkTarget || selected.size === 0) return;
    const to: ColKey = bulkTarget === "none" ? "none" : Number(bulkTarget);
    const ids = [...selected];
    bulkMut.mutate(
      { ids, managerId: keyToManagerId(to) },
      {
        onSuccess: (res) => {
          if (res.errors.length === 0) {
            toast.success(t("v2.branch.bulkDone", { n: res.updated.length }));
            clearSel();
            setSelectMode(false);
          } else {
            const firstErr = res.errors.find((e) => e.detail)?.detail;
            toast.error(t("v2.branch.bulkPartial", { n: res.updated.length, e: res.errors.length }) + (firstErr ? ` — ${firstErr}` : ""), { duration: 8000 });
            setSelected(new Set(res.errors.map((e) => e.id)));
          }
        },
        onError: (e) =>
          toast.error(`${t("v2.branch.bulkFailed")}: ${errText(e, t("v2.branch.noAnswer"))}`, {
            duration: 8000,
            action: { label: t("v2.state.retry"), onClick: runBulk },
          }),
      },
    );
  };

  /* ---------------- manager actions ---------------- */

  async function resetPassword(u: BranchUser) {
    const ok = await confirm({
      title: t("users.reset_pw_q"),
      body: t("users.reset_pw_hint", { name: u.username }),
      confirm: t("users.generate"),
    });
    if (!ok) return;
    resetMut.mutate(u.id, {
      onSuccess: (data) => {
        setCreds({ ...data, kind: "reset", name: userDisplayName(u) });
        toast.success(t("users.password_reset"));
      },
      onError: () => toast.error(t("op_detail.password_reset_failed")),
    });
  }

  async function deleteManager(u: BranchUser) {
    const n = colByKey.get(u.id)?.ops.length ?? 0;
    const ok = await confirm({
      title: (
        <span className="col g4">
          <span>{t("super_manager.delete_q")}</span>
          <span className="s c3" style={{ fontWeight: 400, fontFamily: "inherit" }}>
            {userDisplayName(u)} · {u.username}
          </span>
        </span>
      ),
      body: t("super_manager.delete_hint_tpl", { name: u.username, n }),
      confirm: t("users.deactivate"),
      danger: true,
    });
    if (!ok) return;
    deleteMut.mutate(u.id, {
      onSuccess: () => toast.success(t("users.user_deactivated")),
      onError: (e) => toast.error(errText(e, t("v2.state.errorBody"))),
    });
  }

  const menuFor = (c: Col) => {
    if (c.kind === "manager" && c.user) {
      const u = c.user;
      return [
        { label: t("v2.branch.menuTeam"), onClick: () => setTeamOf(u) },
        { label: t("v2.branch.menuSales"), onClick: () => nav(`/team/sales?manager=${u.id}`) },
        { label: t("v2.branch.menuReset"), onClick: () => resetPassword(u) },
        { label: t("v2.branch.menuDelete"), danger: true, onClick: () => deleteManager(u) },
      ];
    }
    if (c.ops.length === 0) return [];
    return [
      {
        label: t("v2.branch.selectAllCol"),
        onClick: () => {
          setSelectMode(true);
          setSelected((prev) => new Set([...prev, ...c.ops.map((o) => o.id)]));
        },
      },
    ];
  };

  /* ---------------- render ---------------- */

  const header = (
    <PageHeader title={t("v2.branch.title")} meta={t("v2.branch.hint")}>
      <div className="inwrap" style={{ width: 240, maxWidth: "100%" }}>
        <Search className="ic" />
        <input className="input" type="search" placeholder={t("v2.branch.search")} aria-label={t("v2.branch.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <button
        className={cx("btn", selectMode && "btn-pri")}
        type="button"
        aria-pressed={selectMode}
        onClick={() => {
          if (selectMode) clearSel();
          setSelectMode((v) => !v);
        }}
      >
        <CheckSquare className="ic" />
        {selectMode ? t("v2.branch.selectModeOff") : t("v2.branch.selectMode")}
      </button>
      <button className="btn btn-pri" type="button" onClick={() => setAddOpen(true)}>
        <Plus className="ic" />
        {t("v2.branch.addManager")}
      </button>
    </PageHeader>
  );

  if (usersQ.isLoading || opsQ.isLoading) {
    return (
      <>
        {header}
        <main className="page">
          <section className="card">
            <LoadingBlock rows={6} onRetry={() => { usersQ.refetch(); opsQ.refetch(); }} />
          </section>
        </main>
      </>
    );
  }
  if (usersQ.isError || opsQ.isError) {
    return (
      <>
        {header}
        <main className="page">
          <section className="card">
            <ErrorState error={usersQ.error ?? opsQ.error} onRetry={() => { usersQ.refetch(); opsQ.refetch(); }} />
          </section>
        </main>
      </>
    );
  }

  const noManagers = managers.length === 0;
  const bulkTargets = cols.filter((c) => c.kind !== "other" || c.user);

  const renderCard = (o: BranchOperator, c: Col, extra?: { moving?: boolean }) => {
    const isGhost = !extra?.moving && (drag?.opId === o.id || pending?.op.id === o.id);
    const isSel = selected.has(o.id);
    const hit = q ? matches(o) : true;
    const plan = planOf([o]);
    const notes: string[] = [];
    if (extra?.moving) notes.push(t("v2.branch.movingHere"));
    else {
      if (o.status === "inactive") notes.push(t("v2.branch.inactive"));
      if (o.status === "trainee") notes.push(t("v2.branch.trainee"));
      if (o.is_paused) notes.push(t("v2.branch.paused"));
      if (plan) notes.push(t("v2.branch.planPct", { p: plan.pct }));
    }
    const dataS = o.status === "inactive" ? "off" : o.is_paused ? "pause" : undefined;
    const style: CSSProperties = { padding: "8px 10px", gap: 8, cursor: selectMode ? "pointer" : "grab", textAlign: "left", width: "100%" };
    if (q && !hit) style.opacity = 0.35;
    if (q && hit) {
      style.borderColor = "var(--brand)";
      style.boxShadow = "0 0 0 3px var(--brand-soft)";
    }
    if (isSel) style.borderColor = "var(--brand)";
    if (failedId === o.id) {
      style.borderColor = "var(--bad-solid)";
      style.boxShadow = "0 0 0 3px var(--bad-bg)";
    }
    return (
      <div
        key={`${o.id}${extra?.moving ? "-m" : ""}`}
        className={cx("bcard", isGhost && "ghost", extra?.moving && "dragging", isSel && "is-sel")}
        style={style}
        draggable={!extra?.moving && !moveMut.isPending}
        onDragStart={(e) => onCardDragStart(e, o, c.key)}
        onDragEnd={() => {
          setDrag(null);
          setOver(null);
        }}
        role="button"
        tabIndex={0}
        aria-label={selectMode ? t("v2.branch.selectCard", { name: o.full_name }) : t("v2.branch.openOperator", { name: o.full_name })}
        onClick={() => (selectMode ? toggleSel(o.id) : nav(`/operators/${o.id}`))}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (selectMode) toggleSel(o.id);
            else nav(`/operators/${o.id}`);
          }
        }}
      >
        {selectMode ? (
          <input
            className="check"
            type="checkbox"
            checked={isSel}
            aria-label={t("v2.branch.selectCard", { name: o.full_name })}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleSel(o.id)}
          />
        ) : null}
        <span className="ava ava-s" data-s={dataS}>{initials(o.full_name)}</span>
        <span className="col grow" style={{ minWidth: 0 }}>
          <span className="s w6 trunc">
            <Highlight text={o.full_name} q={q} />
          </span>
          {o.phone ? <span className="num xs c3 trunc">{o.phone}</span> : null}
          {notes.length ? <span className="xs c3 trunc">{notes.join(" · ")}</span> : null}
        </span>
        {toNum(o.plan_actual) > 0 ? <span className="num xs w6" style={{ whiteSpace: "nowrap" }}>{fmtMln(o.plan_actual)}</span> : null}
      </div>
    );
  };

  const renderCol = (c: Col) => {
    const plan = planOf(c.ops);
    const isDrop = (over === c.key && drag?.from !== c.key) || pending?.to === c.key;
    const label = c.kind === "direct" ? t("v2.branch.direct") : c.name;
    const movingOp = pending?.to === c.key ? pending.op : null;
    return (
      <section
        key={String(c.key)}
        className={cx("bcol", isDrop && "drop-on")}
        aria-label={label}
        style={{ padding: 10, minWidth: 0, minHeight: 360 }}
        onDragOver={(e) => onColDragOver(e, c.key)}
        onDragLeave={(e) => onColDragLeave(e, c.key)}
        onDrop={(e) => onColDrop(e, c.key)}
      >
        <div className="col g6" style={{ padding: "2px 2px 8px" }}>
          <div className="row g8">
            <span className="ava ava-s">{c.ini}</span>
            <span className="s w6 trunc grow" title={label}>{label}</span>
            <ColumnMenu label={t("v2.branch.colActions", { name: label })} items={menuFor(c)} />
          </div>
          {c.kind === "manager" && c.user ? (
            <>
              <div className="row g6" style={{ minWidth: 0 }}>
                <span className="num xs c2 trunc grow">{c.user.username}</span>
                <span className="badge b-hot" style={{ height: 20 }}>{t("v2.branch.roleManager")}</span>
              </div>
              <span className="xs c3">
                {t("v2.branch.created")} <span className="num">{fmtDate(c.user.date_joined)}</span>
              </span>
              <span className="xs c3">
                {t("v2.branch.lastLogin")} {c.user.last_login ? <span className="num">{fmtLast(c.user.last_login, t)}</span> : t("v2.branch.never")}
              </span>
            </>
          ) : (
            <span className="xs c3">
              {c.kind === "direct" ? t("v2.branch.directHint") : c.kind === "none" ? t("v2.branch.noneHint") : c.user ? c.user.username : t("v2.branch.otherHint")}
            </span>
          )}
          <span className="xs c2 w6">{opsWord(c.ops.length)}</span>
          {plan ? (
            <>
              <div className="row g6">
                <span className="bar grow" style={{ height: 6 }}>
                  <i className={barCls(plan.pct)} style={{ width: `${Math.min(100, plan.pct)}%` }} />
                </span>
                <span className="num xs w6">{plan.pct}%</span>
              </div>
              <span className="xs c3">
                {t("v2.branch.plan")} · <span className="num">{fmtNum(plan.target)}</span> {t("v2.branch.sum")}
              </span>
            </>
          ) : null}
        </div>
        {movingOp ? renderCard(movingOp, c, { moving: true }) : null}
        {c.ops.map((o) => renderCard(o, c))}
        {c.ops.length === 0 && !movingOp ? <div className="ph" style={{ height: 90 }}>{t("v2.branch.dropHere")}</div> : null}
      </section>
    );
  };

  return (
    <>
      {header}
      <main className="page" style={{ position: "relative" }}>
        {q ? (
          <span className={cx("s", matchCount === 0 ? "c-bad" : "c3")}>
            {matchCount === 0 ? t("v2.branch.nothingFound", { q: search.trim() }) : t("v2.branch.foundOf", { n: matchCount, m: ops.length })}
          </span>
        ) : null}

        <div className="board" style={{ gridAutoColumns: "minmax(232px, 1fr)", gap: 10, paddingBottom: 4 }}>
          {cols.map(renderCol)}
          {noManagers ? (
            <div className="ph" style={{ minHeight: 360, gap: 10, padding: 20 }}>
              <i className="ikat-soft" style={{ width: 96, height: 56, borderRadius: 12, display: "block" }} aria-hidden="true" />
              <span className="s w6" style={{ color: "var(--ink)" }}>{t("v2.branch.firstRunTitle")}</span>
              <span className="xs" style={{ maxWidth: 240 }}>{t("v2.branch.firstRunBody")}</span>
              <button className="btn btn-pri btn-sm" type="button" onClick={() => setAddOpen(true)}>
                {t("v2.branch.addManager")}
              </button>
            </div>
          ) : null}
        </div>

        {selected.size > 0 ? (
          <div
            className="row g8 wrap"
            role="region"
            aria-label={t("v2.branch.selected", { n: selected.size })}
            style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", width: "min(760px, calc(100vw - 32px))", zIndex: 40, padding: "10px 12px", borderRadius: 12, background: "var(--ink)", color: "var(--surface)", boxShadow: "var(--shadow)" }}
          >
            <span className="s w6">{t("v2.branch.selected", { n: selected.size })}</span>
            <span className="grow" />
            <select className="input" aria-label={t("v2.branch.moveTo")} style={{ width: 220, height: 34 }} value={bulkTarget} onChange={(e) => setBulkTarget(e.target.value)}>
              <option value="">{t("v2.branch.pickTarget")}</option>
              {bulkTargets.map((c) => (
                <option key={String(c.key)} value={String(c.key)}>
                  {c.kind === "direct" ? t("v2.branch.toDirect") : c.kind === "none" ? t("v2.branch.toNone") : t("v2.branch.toName", { name: c.name })}
                </option>
              ))}
            </select>
            <button className="btn btn-pri btn-sm" type="button" disabled={!bulkTarget || bulkMut.isPending} onClick={runBulk}>
              {t("v2.branch.moveBtn")}
            </button>
            <button className="btn btn-sm" type="button" onClick={clearSel} disabled={bulkMut.isPending}>
              {t("v2.branch.clearSel")}
            </button>
          </div>
        ) : null}
      </main>

      {/* Drag confirm */}
      <Dialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending ? pendingTitle(pending) : ""}
        width={440}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setPending(null)}>{t("common.cancel")}</button>
            <button
              className="btn btn-pri"
              type="button"
              onClick={() => {
                if (pending) doMove(pending.op, pending.from, pending.to);
                setPending(null);
              }}
            >
              {t("v2.branch.moveBtn")}
            </button>
          </>
        }
      >
        {pending ? <p className="s c2">{pendingBody(pending)}</p> : null}
      </Dialog>

      <AddManagerDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        candidates={users.filter((u) => u.username !== meUsername && !["manager", "team_lead", "super_manager", "superadmin"].includes(u.role))}
        promoting={promoteMut.isPending}
        creating={createMut.isPending}
        onPromote={(u, setErr) =>
          promoteMut.mutate(u.id, {
            onSuccess: () => {
              setAddOpen(false);
              toast.success(t("v2.branch.promoted", { name: userDisplayName(u) }));
            },
            onError: (e) => setErr(errText(e, t("v2.state.errorBody"))),
          })
        }
        onCreate={(username, fullName, setErr) =>
          createMut.mutate(
            { username, full_name: fullName },
            {
              onSuccess: (data) => {
                setAddOpen(false);
                setCreds({ id: data.id, username: data.username, password: data.password, kind: "created", name: fullName || data.username });
                toast.success(t("v2.branch.createdToast"));
              },
              onError: (e) => setErr(errText(e, t("v2.state.errorBody"))),
            },
          )
        }
      />

      <CredsDialog creds={creds} onClose={() => setCreds(null)} />

      {teamOf ? (
        <TeamDialog
          manager={teamOf}
          operators={ops}
          userById={userById}
          busy={moveMut.isPending}
          onClose={() => setTeamOf(null)}
          onMove={(op, to) => doMove(op, op.managed_by_id ?? "none", to ?? "none")}
        />
      ) : null}

      {confirm.node}
    </>
  );
}

function fmtLast(iso: string | null, t: (k: string) => string): string {
  if (!iso) return t("v2.branch.never");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return `${t("v2.branch.today")} ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `${t("v2.branch.yesterday")} ${time}`;
  return `${fmtDate(iso)} ${time}`;
}

/* ------------------------------------------------------------------ */
/*  Add manager: promote staff / new phone                              */
/* ------------------------------------------------------------------ */

function AddManagerDialog({
  open,
  onClose,
  candidates,
  promoting,
  creating,
  onPromote,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  candidates: BranchUser[];
  promoting: boolean;
  creating: boolean;
  onPromote: (u: BranchUser, setErr: (s: string) => void) => void;
  onCreate: (username: string, fullName: string, setErr: (s: string) => void) => void;
}) {
  const t = useT2();
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [selId, setSelId] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (open) {
      setSelId("");
      setPhone("");
      setPhoneTouched(false);
      setName("");
      setErr("");
    }
  }, [open]);

  const phoneValid = phone.length === 9;
  const showPhoneErr = phoneTouched && phone.length > 0 && !phoneValid;
  const selUser = candidates.find((c) => String(c.id) === selId);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("v2.branch.newManager")}
      width={480}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
          {mode === "existing" ? (
            <button className="btn btn-pri" type="button" disabled={!selUser || promoting} onClick={() => selUser && onPromote(selUser, setErr)}>
              {promoting ? t("v2.branch.promoting") : t("v2.branch.promote")}
            </button>
          ) : (
            <button
              className="btn btn-pri"
              type="button"
              disabled={!phoneValid || creating}
              onClick={() => onCreate(`+998${phone}`, name.trim(), setErr)}
            >
              {creating ? t("common.creating") : t("common.create")}
            </button>
          )}
        </>
      }
    >
      <div className="seg seg-lg" role="tablist">
        {(["existing", "new"] as const).map((m) => (
          <button
            key={m}
            className={cx(mode === m && "is-on")}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m);
              setErr("");
            }}
          >
            {m === "existing" ? t("v2.branch.fromStaff") : t("v2.branch.newNumber")}
          </button>
        ))}
      </div>

      {mode === "existing" ? (
        candidates.length === 0 ? (
          <div className="banner b-info">
            <UsersIcon className="ic" />
            <span>{t("v2.branch.noCandidates")}</span>
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="br-promote">{t("v2.branch.whoToPromote")}</label>
              <select id="br-promote" className="input" value={selId} onChange={(e) => setSelId(e.target.value)}>
                <option value="">{t("v2.branch.pickStaff", { n: candidates.length })}</option>
                {candidates.map((c) => {
                  const nm = userDisplayName(c);
                  return (
                    <option key={c.id} value={c.id}>
                      {c.username !== nm ? `${nm} · ${c.username}` : nm}
                    </option>
                  );
                })}
              </select>
            </div>
            <span className="hint">{t("v2.branch.promoteHint")}</span>
          </>
        )
      ) : (
        <>
          <div className="field">
            <label htmlFor="br-phone">{t("v2.branch.phoneLogin")}</label>
            <div className="row g8">
              <span className="pfx" style={{ height: 40, fontSize: 14, borderRadius: 9 }} aria-hidden="true">+998</span>
              <input
                id="br-phone"
                className={cx("input num grow", showPhoneErr && "is-bad")}
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                autoFocus
                placeholder="90 123 45 67"
                value={fmtPhone9(phone)}
                aria-invalid={showPhoneErr}
                onChange={(e) => setPhone(digits9(e.target.value))}
                onBlur={() => setPhoneTouched(true)}
              />
            </div>
            {showPhoneErr ? <span className="err">{t("v2.branch.phoneErr")}</span> : null}
          </div>
          <div className="field">
            <label htmlFor="br-name">{t("v2.branch.name")}</label>
            <input id="br-name" className="input" type="text" value={name} placeholder={t("v2.branch.namePh")} onChange={(e) => setName(e.target.value)} />
          </div>
          <span className="hint">{t("v2.branch.newHint")}</span>
        </>
      )}

      {err ? (
        <div className="banner b-bad">
          <AlertTriangle className="ic" />
          <span>{err}</span>
        </div>
      ) : null}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  One-time credentials                                                */
/* ------------------------------------------------------------------ */

function CredsDialog({ creds, onClose }: { creds: (Creds & { kind: "created" | "reset"; name: string }) | null; onClose: () => void }) {
  const t = useT2();
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [creds]);
  const copy = (value: string, okMsg: string) =>
    copyText(value).then(
      () => toast.success(okMsg),
      () => toast.error(t("v2.branch.copyFailed")),
    );
  const row = (label: string, value: string, okMsg: string): ReactNode => (
    <div className="well row between g8">
      <span className="col" style={{ minWidth: 0 }}>
        <span className="xs c3">{label}</span>
        <span className="num w6" style={{ userSelect: "all", wordBreak: "break-all" }}>{value}</span>
      </span>
      <button className="btn btn-sm" type="button" onClick={() => copy(value, okMsg)}>{t("v2.branch.copy")}</button>
    </div>
  );
  return (
    <Dialog
      open={!!creds}
      onClose={onClose}
      locked
      width={460}
      title={creds?.kind === "reset" ? t("v2.branch.credsReset") : t("v2.branch.credsCreated")}
      sub={creds?.name}
      footer={
        <button className="btn btn-pri" type="button" disabled={!saved} onClick={onClose}>
          {t("common.done")}
        </button>
      }
    >
      {creds ? (
        <>
          <div className="banner b-warn">
            <AlertTriangle className="ic" />
            <span>{t("users.pw_only_now")}</span>
          </div>
          {row(t("v2.branch.login"), creds.username, t("toast.copied_login"))}
          {row(t("v2.branch.password"), creds.password, t("toast.copied_password"))}
          <label className="row g8 s">
            <input className="check" type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            {t("v2.branch.saved")}
          </label>
        </>
      ) : null}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Manager team (old MyManagers team modal)                            */
/* ------------------------------------------------------------------ */

function TeamDialog({
  manager,
  operators,
  userById,
  busy,
  onClose,
  onMove,
}: {
  manager: BranchUser;
  operators: BranchOperator[];
  userById: Map<number, BranchUser>;
  busy: boolean;
  onClose: () => void;
  onMove: (op: BranchOperator, to: number | null) => void;
}) {
  const t = useT2();
  const [addSel, setAddSel] = useState("");
  const team = operators.filter((o) => o.managed_by_id === manager.id);
  const pool = operators.filter((o) => o.managed_by_id !== manager.id);
  const name = userDisplayName(manager);
  return (
    <Dialog
      open
      onClose={onClose}
      width={720}
      title={
        <span className="row g12">
          <span className="icon-tile t-info"><UsersIcon className="ic" /></span>
          <span>{t("v2.branch.teamOf", { name: manager.username })}</span>
        </span>
      }
      sub={`${name} · ${t(pluralKey("v2.branch.ops", team.length), { n: team.length })}`}
      footer={<button className="btn btn-ghost" type="button" onClick={onClose}>{t("common.done")}</button>}
    >
      {team.length === 0 ? (
        <div className="well empty" style={{ padding: "24px 16px" }}>
          <span className="s">{t("super_manager.team_empty")}</span>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6, maxHeight: 280, overflow: "auto" }}>
          {team.map((o) => (
            <div key={o.id} className="well row g8" style={{ padding: "8px 12px" }}>
              <span className="col grow" style={{ minWidth: 0 }}>
                <span className="s w5 trunc">{o.full_name}</span>
                <span className="num xs c3">{o.phone ?? "—"}</span>
              </span>
              <button
                className="btn btn-sm btn-sq btn-bad"
                type="button"
                aria-label={`${t("super_manager.remove_from_team")}: ${o.full_name}`}
                title={t("super_manager.remove_from_team")}
                disabled={busy}
                onClick={() => onMove(o, null)}
              >
                <X className="ic ic-s" />
              </button>
            </div>
          ))}
        </div>
      )}
      {pool.length > 0 ? (
        <>
          <hr className="hr" />
          <div className="field">
            <label htmlFor="br-team-add">{t("super_manager.add_from_pool")}</label>
            <div className="row g8">
              <select id="br-team-add" className="input grow" value={addSel} onChange={(e) => setAddSel(e.target.value)}>
                <option value="">{t("super_manager.select_operator")}</option>
                {pool.map((o) => {
                  const owner = o.managed_by_id ? userById.get(o.managed_by_id)?.username ?? `#${o.managed_by_id}` : null;
                  const suffix = owner ? t("super_manager.currently_with", { name: owner }) : t("super_manager.unassigned");
                  return (
                    <option key={o.id} value={o.id}>
                      {o.full_name} ({o.phone ?? "—"}) — {suffix}
                    </option>
                  );
                })}
              </select>
              <button
                className="btn btn-pri"
                type="button"
                disabled={!addSel || busy}
                onClick={() => {
                  const op = pool.find((o) => String(o.id) === addSel);
                  if (op) onMove(op, manager.id);
                  setAddSel("");
                }}
              >
                <Plus className="ic" />
                {t("common.add")}
              </button>
            </div>
            <span className="hint">{t("super_manager.add_hint")}</span>
          </div>
        </>
      ) : null}
    </Dialog>
  );
}
