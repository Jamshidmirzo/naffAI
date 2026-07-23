/**
 * Admin CRUD for `SheetSource` (per-worksheet column mapping) and
 * `OperatorSheetAlias` (sheet alias → real operator binding).
 *
 * Column map is edited as raw JSON — the admin will only need it a
 * handful of times per year and the shape is documented in the field
 * placeholder.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

type SheetSource = {
  id: number;
  name: string;
  spreadsheet_id: string;
  gid: number;
  worksheet_name: string;
  column_map: Record<string, unknown>;
  default_status: string;
  active: boolean;
  last_synced_at: string | null;
  last_synced_row: number;
};

type Alias = {
  id: number;
  alias_name: string;
  operator: number | null;
  operator_name: string | null;
};

type Operator = { id: number; full_name: string; status: string };

export default function SheetSources() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"sources" | "aliases">("sources");

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Google Sheets</h1>
        <div className="text-sm text-gray-500 dark:text-slate-400">
          Маппинг листов на модель лида и alias'ы операторов.
        </div>
      </div>

      <div className="border-b border-gray-200 dark:border-slate-800 flex gap-4">
        <TabButton active={tab === "sources"} onClick={() => setTab("sources")}>
          Листы
        </TabButton>
        <TabButton active={tab === "aliases"} onClick={() => setTab("aliases")}>
          Alias'ы операторов
        </TabButton>
      </div>

      {tab === "sources" ? <SheetSourcesPanel qc={qc} /> : <AliasesPanel qc={qc} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`pb-2 -mb-px border-b-2 text-sm font-medium ${
        active
          ? "border-accent text-accent"
          : "border-transparent text-gray-500 hover:text-gray-800 dark:text-slate-400 dark:hover:text-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

// ---- Sheet sources ------------------------------------------------------

function SheetSourcesPanel({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const q = useQuery({
    queryKey: ["sheet-sources"],
    queryFn: () =>
      api
        .get<SheetSource[] | { results?: SheetSource[] }>("/sheet-sources/")
        .then((r) => (Array.isArray(r.data) ? r.data : r.data.results || [])),
  });

  const [edit, setEdit] = useState<SheetSource | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const items = q.data || [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button className="btn-primary text-sm" onClick={() => setShowCreate(true)}>
          + Добавить лист
        </button>
      </div>
      <div className="card overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 dark:bg-slate-800/40 text-xs uppercase text-gray-500 dark:text-slate-400">
            <tr>
              <th className="text-left px-3 py-2">Название</th>
              <th className="text-left px-3 py-2">Spreadsheet</th>
              <th className="text-left px-3 py-2">gid</th>
              <th className="text-left px-3 py-2">Дефолт</th>
              <th className="text-left px-3 py-2">Последняя строка</th>
              <th className="text-right px-3 py-2">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
            {items.map((src) => (
              <tr key={src.id} className="hover:bg-gray-50/70 dark:hover:bg-slate-800/40">
                <td className="px-3 py-2 font-medium">
                  {src.name}
                  {!src.active && (
                    <span className="text-xs text-gray-400 ml-2">(отключён)</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{src.spreadsheet_id}</td>
                <td className="px-3 py-2 font-mono text-xs">{src.gid}</td>
                <td className="px-3 py-2">{src.default_status}</td>
                <td className="px-3 py-2">
                  #{src.last_synced_row}
                  {src.last_synced_at && (
                    <div className="text-xs text-gray-400">
                      {new Date(src.last_synced_at).toLocaleString("ru-RU")}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <button className="btn-ghost text-xs" onClick={() => setEdit(src)}>
                    Редактировать
                  </button>
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={6} className="text-center text-gray-500 py-6">
                  Пока не настроены
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(edit || showCreate) && (
        <SheetSourceForm
          value={edit}
          onClose={() => {
            setEdit(null);
            setShowCreate(false);
          }}
          onDone={() => {
            setEdit(null);
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ["sheet-sources"] });
          }}
        />
      )}
    </div>
  );
}

function SheetSourceForm({
  value,
  onClose,
  onDone,
}: {
  value: SheetSource | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = !!value;
  const [name, setName] = useState(value?.name || "");
  const [ss, setSs] = useState(value?.spreadsheet_id || "");
  const [gid, setGid] = useState(String(value?.gid || ""));
  const [ws, setWs] = useState(value?.worksheet_name || "");
  const [defaultStatus, setDefaultStatus] = useState(value?.default_status || "new");
  const [active, setActive] = useState(value?.active ?? true);
  const [mapJson, setMapJson] = useState(
    JSON.stringify(value?.column_map || {}, null, 2)
  );
  const [error, setError] = useState("");

  const mut = useMutation({
    mutationFn: async () => {
      let columnMap: unknown;
      try {
        columnMap = JSON.parse(mapJson);
      } catch {
        throw new Error("column_map — некорректный JSON");
      }
      const body = {
        name,
        spreadsheet_id: ss,
        gid: Number(gid),
        worksheet_name: ws,
        column_map: columnMap,
        default_status: defaultStatus,
        active,
      };
      if (isEdit) {
        await api.patch(`/sheet-sources/${value!.id}/`, body);
      } else {
        await api.post("/sheet-sources/", body);
      }
    },
    onSuccess: onDone,
    onError: (err: any) => setError(err?.response?.data?.detail || err?.message || "Ошибка"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl card p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold">{isEdit ? "Редактировать лист" : "Новый лист"}</div>
          <button className="btn-ghost text-xs" onClick={onClose}>
            Закрыть
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Название</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">Дефолтный статус</label>
            <select
              className="input"
              value={defaultStatus}
              onChange={(e) => setDefaultStatus(e.target.value)}
            >
              <option value="new">new</option>
              <option value="archived">archived</option>
              <option value="needs_review">needs_review</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="label">Spreadsheet ID</label>
            <input className="input font-mono" value={ss} onChange={(e) => setSs(e.target.value)} />
          </div>
          <div>
            <label className="label">gid</label>
            <input
              className="input font-mono"
              value={gid}
              onChange={(e) => setGid(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Название листа (опц.)</label>
            <input className="input" value={ws} onChange={(e) => setWs(e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="label">Column map (JSON)</label>
            <textarea
              className="input font-mono text-xs min-h-[220px]"
              value={mapJson}
              onChange={(e) => setMapJson(e.target.value)}
              placeholder='{"full_name": "full_name", "phone": "phone_number", "operator_alias": {"column_index": 5}}'
            />
          </div>
          <div className="col-span-2">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Активен (участвует в sync)
            </label>
          </div>
        </div>
        {error && <div className="text-sm text-rose-600 mt-2">{error}</div>}
        <div className="mt-4 flex gap-2 justify-end">
          <button className="btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn-primary"
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
          >
            {mut.isPending ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Aliases -----------------------------------------------------------

function AliasesPanel({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const q = useQuery({
    queryKey: ["operator-sheet-aliases"],
    queryFn: () =>
      api
        .get<Alias[] | { results?: Alias[] }>("/operator-sheet-aliases/")
        .then((r) => (Array.isArray(r.data) ? r.data : r.data.results || [])),
  });
  const ops = useQuery({
    queryKey: ["operators-active"],
    queryFn: () =>
      api
        .get<Operator[] | { results?: Operator[] }>("/operators/?include_inactive=0")
        .then((r) => (Array.isArray(r.data) ? r.data : r.data.results || [])),
  });
  const [creating, setCreating] = useState(false);
  const items = q.data || [];
  const unboundCount = items.filter((a) => !a.operator).length;

  const bind = async (alias: Alias, operatorId: number | null) => {
    await api.patch(`/operator-sheet-aliases/${alias.id}/`, { operator: operatorId });
    qc.invalidateQueries({ queryKey: ["operator-sheet-aliases"] });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          {unboundCount > 0 && (
            <span className="text-sm font-medium text-amber-600 dark:text-amber-400">
              Непривязанных alias'ов: {unboundCount}
            </span>
          )}
        </div>
        <button className="btn-primary text-sm" onClick={() => setCreating(true)}>
          + Alias
        </button>
      </div>
      <div className="card overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 dark:bg-slate-800/40 text-xs uppercase text-gray-500 dark:text-slate-400">
            <tr>
              <th className="text-left px-3 py-2">Alias (как в листе)</th>
              <th className="text-left px-3 py-2">Оператор</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
            {items.map((a) => (
              <tr key={a.id}>
                <td className="px-3 py-2 font-medium">
                  {a.alias_name}
                  {!a.operator && (
                    <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300 ml-2">
                      Не привязан
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <select
                    className="input max-w-xs"
                    value={a.operator || ""}
                    onChange={(e) => bind(a, e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">— не привязан —</option>
                    {(ops.data || []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.full_name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={2} className="text-center text-gray-500 py-6">
                  Alias'ов ещё нет — они создаются автоматически при sync'е из листов
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <NewAliasModal
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ["operator-sheet-aliases"] });
          }}
        />
      )}
    </div>
  );
}

function NewAliasModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const mut = useMutation({
    mutationFn: async () => {
      await api.post("/operator-sheet-aliases/", { alias_name: name });
    },
    onSuccess: onDone,
    onError: (err: any) => setError(err?.response?.data?.detail || err?.message || "Ошибка"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold">Новый alias</div>
          <button className="btn-ghost text-xs" onClick={onClose}>
            Закрыть
          </button>
        </div>
        <label className="label">Как оператор написан в листе</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        {error && <div className="text-sm text-rose-600 mt-2">{error}</div>}
        <div className="mt-4 flex gap-2 justify-end">
          <button className="btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn-primary"
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !name.trim()}
          >
            {mut.isPending ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}
