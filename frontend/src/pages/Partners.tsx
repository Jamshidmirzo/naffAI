import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../lib/api";
import { Button, Modal, StatusBadge, toast } from "../components/ui";
import { usePageHeader } from "../store/page";

interface Partner {
  id: number;
  name: string;
  is_active: boolean;
}

export default function Partners() {
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");

  usePageHeader({ title: "Партнёры", subtitle: "Каналы продаж" });

  const list = useQuery({
    queryKey: ["partners"],
    queryFn: () => api.get("/channels/").then((r) => r.data),
  });

  const create = useMutation({
    mutationFn: (body: { name: string; is_active: boolean }) =>
      api.post("/channels/", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["partners"] });
      qc.invalidateQueries({ queryKey: ["partners-list"] });
      setShow(false);
      setName("");
      toast.success("Партнёр добавлен");
    },
  });

  const toggle = useMutation({
    mutationFn: (p: { id: number; is_active: boolean }) =>
      api.patch(`/channels/${p.id}/`, { is_active: p.is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["partners"] });
      qc.invalidateQueries({ queryKey: ["partners-list"] });
    },
  });

  const rows: Partner[] = list.data?.results || [];

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      <div className="flex items-center justify-between animate-nfFadeUp">
        <div className="text-[13px] text-muted">Всего: {rows.length}</div>
        <Button onClick={() => setShow(true)}>
          <Plus className="w-3.5 h-3.5" /> Добавить
        </Button>
      </div>

      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: "1.4fr .6fr .6fr" }}
        >
          <div>Название</div>
          <div>Статус</div>
          <div className="text-right">Действие</div>
        </div>
        {rows.length === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">
            Партнёров пока нет
          </div>
        ) : (
          <div>
            {rows.map((p, i) => (
              <div
                key={p.id}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: "1.4fr .6fr .6fr",
                  animationDelay: `${0.02 + i * 0.035}s`,
                  cursor: "default",
                }}
              >
                <div className="font-medium">{p.name}</div>
                <div>
                  <StatusBadge tone={p.is_active ? "hot" : "neutral"}>
                    {p.is_active ? "активен" : "выключен"}
                  </StatusBadge>
                </div>
                <div className="text-right">
                  <button
                    className="nf-btn nf-btn--ghost"
                    style={{ padding: "7px 14px", fontSize: 12.5 }}
                    onClick={() =>
                      toggle.mutate({ id: p.id, is_active: !p.is_active })
                    }
                  >
                    {p.is_active ? "Выключить" : "Включить"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal open={show} onClose={() => setShow(false)} width={440}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            create.mutate({ name: name.trim(), is_active: true });
          }}
          className="p-7"
        >
          <div className="text-[18px] font-semibold tracking-tight">Новый партнёр</div>
          <div className="mt-5">
            <div className="nf-col mb-1.5">Название</div>
            <input
              className="nf-input"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Alif / Uzum / Hamroh / TBC / Cash…"
              autoFocus
            />
          </div>
          <div className="mt-6 flex gap-2 justify-end">
            <Button variant="ghost" type="button" onClick={() => setShow(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? "Сохраняем…" : "Сохранить"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
