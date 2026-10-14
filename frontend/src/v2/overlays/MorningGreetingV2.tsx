import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useMe } from "../../hooks/useMe";
import { t2 } from "../i18n";
import { Layer } from "./shift";

interface Payload {
  quote: string;
  author: string;
  language: string;
  should_show: boolean;
  generated_by_model: string;
}

/**
 * v2 morning greeting (artboard OpMorning). Logic = old
 * components/MorningGreeting.tsx: GET /me/morning-greeting/?language=…,
 * opens once when should_show, closing (button or backdrop) POSTs
 * /me/morning-greeting/dismiss/ so it stays hidden until the date rolls.
 * Texts follow the operator's profile language, not the UI language.
 * The artboard's «вчера / сегодня» stats are not in this API, so not drawn.
 */
export default function MorningGreetingV2({ language = "uz" }: { language?: "ru" | "uz" }) {
  const qc = useQueryClient();
  const me = useMe();
  const [open, setOpen] = useState(false);
  const q = useQuery<Payload>({
    queryKey: ["morning-greeting", language],
    queryFn: async () => (await api.get<Payload>(`/me/morning-greeting/?language=${language}`)).data,
    staleTime: 60_000,
  });

  const dismiss = useMutation({
    mutationFn: () => api.post("/me/morning-greeting/dismiss/"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["morning-greeting"] }),
  });

  useEffect(() => {
    if (q.data?.should_show) setOpen(true);
  }, [q.data?.should_show]);

  if (!open || !q.data) return null;

  const tl = (key: string, p?: Record<string, string | number>) => t2(language, key, p);
  const fullName = me.data?.operator_name || me.data?.display_name || "";
  const firstName = fullName.trim().split(/\s+/)[0] || "";
  const date = new Date().toLocaleDateString(language === "uz" ? "uz-UZ" : "ru-RU", { weekday: "long", day: "numeric", month: "long" });

  const onClose = () => {
    setOpen(false);
    dismiss.mutate();
  };

  return (
    <Layer z={50}>
      <div className="scrim" onClick={onClose} />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "none" }}>
        <section className="dlg" role="dialog" aria-modal="true" aria-labelledby="v2-mg-title" style={{ width: 520, maxWidth: "100%", overflow: "hidden", pointerEvents: "auto" }}>
          <i className="ikat" style={{ height: 12, flex: "none" }} aria-hidden />
          <div className="col g16" style={{ padding: "clamp(20px, 3vw, 28px)" }}>
            <span className="lbl" style={{ color: "var(--brand-text)" }}>{date}</span>
            <h2 className="display" id="v2-mg-title" style={{ fontSize: 26, lineHeight: "34px", margin: 0 }}>
              {firstName ? tl("v2.ov.morning.hello", { name: firstName }) : tl("v2.ov.morning.helloNoName")}
            </h2>
            <blockquote className="well" style={{ margin: 0, fontSize: 16, lineHeight: "24px" }}>
              {q.data.quote}
              <span className="xs c3" style={{ display: "block", marginTop: 8 }}>
                {q.data.author ? `— ${q.data.author}` : tl("v2.ov.morning.source")}
              </span>
            </blockquote>
            <button className="btn btn-pri btn-lg btn-block" type="button" onClick={onClose} disabled={dismiss.isPending}>
              {tl("v2.ov.morning.cta")}
            </button>
            <span className="xs c3" style={{ textAlign: "center" }}>{tl("v2.ov.morning.once")}</span>
          </div>
        </section>
      </div>
    </Layer>
  );
}
