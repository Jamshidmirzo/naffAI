import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";
import { Modal } from "./Modal";

interface PaletteResponse {
  palette: string[];
  taken: { emoji: string; operator_name: string }[];
  rare: { emoji: string; operator_id: number; operator_name: string } | null;
}

interface MySticker {
  emoji: string;
  is_rare: boolean;
  operator_id: number;
}

interface Props {
  /** null means "regular self picker". Number means admin picking for that op. */
  operatorId: number | null;
  currentEmoji: string | null;
  currentIsRare: boolean;
  onChanged: () => void;
  onClose: () => void;
  /** True enables the "grant rare" mode for admins. */
  adminMode?: boolean;
}

export function StickerPicker({
  operatorId,
  currentEmoji,
  currentIsRare,
  onChanged,
  onClose,
  adminMode = false,
}: Props) {
  const qc = useQueryClient();
  const [rareMode, setRareMode] = useState<boolean>(currentIsRare);
  const [rareEmoji, setRareEmoji] = useState<string>(
    currentIsRare && currentEmoji ? currentEmoji : ""
  );
  const [error, setError] = useState<string | null>(null);

  const palette = useQuery<PaletteResponse>({
    queryKey: ["stickers", "palette"],
    queryFn: () => api.get("/stickers/palette/").then((r) => r.data as PaletteResponse),
  });

  const takenMap = new Map<string, string>();
  (palette.data?.taken ?? []).forEach((t) => takenMap.set(t.emoji, t.operator_name));

  const setSticker = useMutation({
    mutationFn: async (payload: { emoji: string; is_rare: boolean }) => {
      const url =
        operatorId === null ? "/me/sticker/" : `/operators/${operatorId}/sticker/`;
      const r = await api.put(url, payload);
      return r.data as MySticker;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stickers", "palette"] });
      qc.invalidateQueries({ queryKey: ["operators"] });
      qc.invalidateQueries({ queryKey: ["me", "sticker"] });
      onChanged();
      onClose();
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const clear = useMutation({
    mutationFn: async () => {
      const url =
        operatorId === null ? "/me/sticker/" : `/operators/${operatorId}/sticker/`;
      await api.delete(url);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stickers", "palette"] });
      qc.invalidateQueries({ queryKey: ["operators"] });
      qc.invalidateQueries({ queryKey: ["me", "sticker"] });
      onChanged();
      onClose();
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const pick = (emoji: string) => {
    setError(null);
    if (takenMap.has(emoji) && emoji !== currentEmoji) return;
    setSticker.mutate({ emoji, is_rare: false });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={adminMode ? "Стикер оператора" : "Мой стикер"}
      widthClass="max-w-lg"
    >
      <div className="space-y-4">
        {adminMode && (
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={!rareMode}
                onChange={() => setRareMode(false)}
              />
              Обычный
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={rareMode}
                onChange={() => setRareMode(true)}
              />
              Rare (уникальный на всю систему)
            </label>
          </div>
        )}

        {rareMode ? (
          <div className="space-y-3">
            <label className="label">Rare-эмодзи (можно любой)</label>
            <input
              className="input text-2xl text-center"
              value={rareEmoji}
              onChange={(e) => setRareEmoji(e.target.value.slice(0, 4))}
              placeholder="👑"
              autoFocus
            />
            {palette.data?.rare && palette.data.rare.operator_id !== operatorId && (
              <div className="text-xs text-amber-600">
                Сейчас rare: {palette.data.rare.emoji} у {palette.data.rare.operator_name}.
                Будет снят.
              </div>
            )}
            <button
              className="btn-primary w-full"
              disabled={!rareEmoji || setSticker.isPending}
              onClick={() => setSticker.mutate({ emoji: rareEmoji, is_rare: true })}
            >
              Выдать rare
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-10 gap-2 max-h-80 overflow-y-auto p-1">
              {(palette.data?.palette ?? []).map((emoji) => {
                const owner = takenMap.get(emoji);
                const isCurrent = emoji === currentEmoji;
                const disabled = !!owner && !isCurrent;
                return (
                  <button
                    key={emoji}
                    type="button"
                    title={
                      disabled
                        ? `Занят: ${owner}`
                        : isCurrent
                        ? "Ваш текущий"
                        : "Выбрать"
                    }
                    disabled={disabled || setSticker.isPending}
                    onClick={() => pick(emoji)}
                    className={
                      "aspect-square text-2xl flex items-center justify-center rounded border " +
                      (isCurrent
                        ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30"
                        : disabled
                        ? "border-transparent opacity-25 cursor-not-allowed"
                        : "border-gray-200 dark:border-slate-700 hover:bg-gray-100 dark:hover:bg-slate-800")
                    }
                  >
                    {emoji}
                  </button>
                );
              })}
            </div>
            {currentEmoji && (
              <button
                type="button"
                className="btn-ghost w-full text-red-500"
                onClick={() => clear.mutate()}
                disabled={clear.isPending}
              >
                Убрать стикер
              </button>
            )}
          </>
        )}

        {error && <div className="text-sm text-red-500">{error}</div>}
      </div>
    </Modal>
  );
}
