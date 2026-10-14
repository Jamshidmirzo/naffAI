import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum } from "../ui";
import { useAuditLog, type AuditRow } from "../api/team/people";

const TZ = "Asia/Tashkent";
const COLS = "112px 140px 190px 210px minmax(0, 1fr)";

type T = ReturnType<typeof useT2>;

/** Translate if the key exists, otherwise undefined (t() returns the key itself when missing). */
function tryT(t: T, key: string, params?: Record<string, string | number>) {
  const v = t(key, params);
  return v === key ? undefined : v;
}

function humanize(code: string) {
  const s = code.replace(/^.*\./, "").replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : code;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

interface Change {
  field: string;
  old?: unknown;
  hasOld: boolean;
  next: unknown;
}

/** Split an audit `changes` blob into field-level rows, whatever shape the service wrote. */
function normalize(changes: unknown): Change[] {
  if (changes === null || changes === undefined) return [];
  if (!isObj(changes)) return [{ field: "", hasOld: false, next: changes }];
  const c = changes;
  const keys = Object.keys(c);
  if (!keys.length) return [];

  // {"before": {...}, "after": {...}}
  if (isObj(c.before) && isObj(c.after)) {
    const b = c.before;
    const a = c.after;
    const out: Change[] = [];
    for (const k of Array.from(new Set([...Object.keys(b), ...Object.keys(a)]))) {
      if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) out.push({ field: k, old: b[k], hasOld: true, next: a[k] });
    }
    for (const k of keys) if (k !== "before" && k !== "after") out.push({ field: k, hasOld: false, next: c[k] });
    return out;
  }
  // {"field": "x", "old": …, "new": …}
  if (typeof c.field === "string" && ("old" in c || "new" in c)) {
    const out: Change[] = [{ field: c.field, old: c.old, hasOld: "old" in c, next: c.new }];
    for (const k of keys) if (!["field", "old", "new"].includes(k)) out.push({ field: k, hasOld: false, next: c[k] });
    return out;
  }
  // {"old": …, "new": …}
  if (keys.every((k) => k === "old" || k === "new")) return [{ field: "", old: c.old, hasOld: "old" in c, next: c.new }];

  return keys.map((k) => {
    const v = c[k];
    if (isObj(v) && Object.keys(v).length && Object.keys(v).every((x) => x === "old" || x === "new")) {
      return { field: k, old: v.old, hasOld: "old" in v, next: v.new };
    }
    if (typeof v === "string") {
      const m = /^(.+?)\s*(?:→|->)\s*(.+)$/.exec(v);
      if (m) return { field: k, old: m[1], hasOld: true, next: m[2] };
    }
    return { field: k, hasOld: false, next: v };
  });
}

const MONEY = /(amount|sum|total|net|discount|price|penalty|bonus|threshold|narxi|uzs|salary|payout_value|target)/i;

function fmtValue(t: T, field: string, v: unknown, depth = 0): string {
  if (v === null || v === undefined || v === "" || v === "None" || v === "null") return "—";
  if (v === true || v === "True" || v === "true") return t("v2.team.people.audit.yes");
  if (v === false || v === "False" || v === "false") return t("v2.team.people.audit.no");
  if (Array.isArray(v)) {
    if (!v.length) return "—";
    if (v.every((x) => typeof x !== "object" || x === null)) {
      const s = v.map((x) => fmtValue(t, field, x, depth + 1)).join(", ");
      return s.length > 160 ? t("v2.team.people.audit.items", { n: v.length }) : s;
    }
    return t("v2.team.people.audit.items", { n: v.length });
  }
  if (isObj(v)) {
    if (depth > 0) return "…";
    const parts = Object.entries(v).map(([k, x]) => `${fieldLabel(t, k)}: ${fmtValue(t, k, x, depth + 1)}`);
    const s = parts.join("; ");
    return s.length > 200 ? s.slice(0, 199) + "…" : s;
  }
  if (typeof v === "number") return MONEY.test(field) && Math.abs(v) >= 1000 ? fmtNum(v) : String(v).replace(".", ",");
  const s = String(v);
  if (s === "<redacted>") return t("v2.team.people.audit.hidden");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime()))
      return d.toLocaleString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "");
  }
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dm) return `${dm[3]}.${dm[2]}.${dm[1]}`;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (MONEY.test(field) && Math.abs(n) >= 1000) return fmtNum(n);
    return s.includes(".") ? String(n).replace(".", ",") : s;
  }
  const known = /^[a-z_]+$/.test(s) ? tryT(t, `v2.team.people.audit.val.${s}`) : undefined;
  if (known) return known;
  return s.length > 160 ? s.slice(0, 159) + "…" : s;
}

function fieldLabel(t: T, field: string) {
  if (!field) return "";
  return tryT(t, `v2.team.people.audit.field.${field}`) ?? humanize(field);
}

function entityLabel(t: T, entity: string) {
  if (!entity) return "—";
  return tryT(t, `v2.team.people.audit.entity.${entity}`) ?? (entity.startsWith("op:") ? t("v2.team.people.audit.entity.operators.Operator") : humanize(entity));
}

function actionLabel(t: T, action: string) {
  return tryT(t, `v2.team.people.audit.action.${action}`) ?? humanize(action);
}

function actionTone(action: string) {
  if (action === "delete") return "b-bad";
  if (action === "create") return "b-info";
  if (action === "override") return "b-warn";
  if (/fail|denied/.test(action)) return "b-bad";
  return "";
}

function objectHref(entity: string, id: string | number) {
  if (entity === "sales.Sale") return `/sales/${id}`;
  if (entity === "operators.Operator") return `/operators/${id}`;
  return null;
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { short: "—", full: "" };
  const date = d.toLocaleDateString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit" });
  const time = d.toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const full = d.toLocaleString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return { short: `${date} ${time}`, full };
}

export default function Audit() {
  const t = useT2();
  const [search, setSearch] = useState("");
  const [entity, setEntity] = useState("");
  const q = useAuditLog(entity);

  const rows: AuditRow[] = useMemo(() => q.data?.pages.flatMap((p) => p.results ?? []) ?? [], [q.data]);
  const total = q.data?.pages[0]?.count ?? 0;

  // Entity chips: everything seen so far, so the list does not collapse when one is picked.
  const [seen, setSeen] = useState<string[]>([]);
  useEffect(() => {
    setSeen((prev) => {
      const s = new Set(prev);
      let changed = false;
      rows.forEach((r) => {
        if (r.entity && !s.has(r.entity)) {
          s.add(r.entity);
          changed = true;
        }
      });
      return changed ? Array.from(s).sort() : prev;
    });
  }, [rows]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) => {
      const bag = [
        r.user_name ?? "",
        r.action,
        actionLabel(t, r.action),
        r.entity,
        entityLabel(t, r.entity),
        String(r.entity_id),
        fmtWhen(r.created_at).short,
        r.comment ?? "",
        JSON.stringify(r.changes),
        normalize(r.changes).map((c) => `${fieldLabel(t, c.field)} ${fmtValue(t, c.field, c.old)} ${fmtValue(t, c.field, c.next)}`).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return bag.includes(term);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search]);

  return (
    <>
      <PageHeader title={t("audit.title")} meta={t("v2.team.people.audit.sub")}>
        <div className="inwrap" style={{ width: 320, maxWidth: "100%" }}>
          <Search className="ic" />
          <input
            className="input"
            type="search"
            placeholder={t("v2.team.people.audit.searchPh")}
            aria-label={t("v2.team.people.audit.searchAria")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </PageHeader>

      <main className="page" style={{ gap: 16 }}>
        {seen.length > 0 ? (
          <div className="row g8 wrap">
            <button className={cx("chip", entity === "" && "is-on")} type="button" onClick={() => setEntity("")}>
              {t("v2.team.people.audit.allObjects")}
            </button>
            {seen.map((e) => (
              <button key={e} className={cx("chip", entity === e && "is-on")} type="button" title={e} onClick={() => setEntity(e)}>
                {entityLabel(t, e)}
              </button>
            ))}
          </div>
        ) : null}

        <section className="card tbl" style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 900 }}>
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <span>{t("v2.team.people.audit.colWhen")}</span>
              <span>{t("v2.team.people.audit.colWho")}</span>
              <span>{t("v2.team.people.audit.colAction")}</span>
              <span>{t("v2.team.people.audit.colObject")}</span>
              <span>{t("v2.team.people.audit.colChanges")}</span>
            </div>
            {q.isLoading ? (
              <LoadingBlock rows={6} onRetry={() => q.refetch()} />
            ) : q.isError ? (
              <ErrorState error={q.error} onRetry={() => q.refetch()} />
            ) : filtered.length === 0 ? (
              <EmptyState
                title={rows.length === 0 && !entity ? t("v2.team.people.audit.emptyAll") : t("v2.team.people.audit.empty")}
                body={search && q.hasNextPage ? t("v2.team.people.audit.emptyMore") : undefined}
              />
            ) : (
              filtered.map((r) => {
                const when = fmtWhen(r.created_at);
                const changes = normalize(r.changes);
                const href = objectHref(r.entity, r.entity_id);
                const objText = `${entityLabel(t, r.entity)} #${r.entity_id}`;
                return (
                  <div
                    key={r.id}
                    className="tr"
                    style={{ gridTemplateColumns: COLS, alignItems: "start", paddingTop: 12, paddingBottom: 12 }}
                  >
                    <span className="num s c2" title={when.full}>{when.short}</span>
                    <span className={cx("s trunc", r.user_name ? "w6" : "c3")}>{r.user_name || t("v2.team.people.audit.system")}</span>
                    <span style={{ minWidth: 0 }}>
                      <span
                        className={cx("badge", actionTone(r.action))}
                        title={r.action}
                        style={{ height: "auto", minHeight: 22, padding: "3px 8px", whiteSpace: "normal" }}
                      >
                        {actionLabel(t, r.action)}
                      </span>
                    </span>
                    <span className="xs c2 trunc" style={{ paddingTop: 2 }} title={`${r.entity}#${r.entity_id}`}>
                      {href ? <Link to={href} style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 2 }}>{objText}</Link> : objText}
                    </span>
                    <span className="col g4" style={{ minWidth: 0 }}>
                      {changes.length === 0 && !r.comment ? <span className="xs c3">—</span> : null}
                      {changes.map((c, i) => (
                        <span key={i} className="s" style={{ overflowWrap: "anywhere" }}>
                          {c.field ? <span className="xs c3">{fieldLabel(t, c.field)}: </span> : null}
                          {c.hasOld ? (
                            <>
                              <span className="num xs c3" style={{ textDecoration: "line-through" }}>{fmtValue(t, c.field, c.old)}</span>{" "}
                              <span className="c3">→</span>{" "}
                            </>
                          ) : null}
                          <span className="num xs w6">{fmtValue(t, c.field, c.next)}</span>
                        </span>
                      ))}
                      {r.comment ? (
                        <span className="xs c2" style={{ fontStyle: "italic", overflowWrap: "anywhere" }}>
                          {t("v2.team.people.audit.comment")}: {r.comment}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {!q.isLoading && !q.isError && rows.length > 0 ? (
          <div className="row between wrap g8">
            <span className="s c3">
              {t("v2.team.people.audit.shown", { n: rows.length, total })}
            </span>
            {q.hasNextPage ? (
              <button className="btn" type="button" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                {q.isFetchingNextPage ? t("common.loading") : t("v2.team.people.audit.more")}
              </button>
            ) : null}
          </div>
        ) : null}
      </main>
    </>
  );
}
