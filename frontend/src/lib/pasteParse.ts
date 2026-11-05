/**
 * «Вставить и раздать»: разбор строк, скопированных из Google Sheets / Excel.
 *
 * Буфер обмена приходит как TSV: ячейки через Tab, строки через перевод
 * строки; ячейка с переносом / Tab / кавычкой обёрнута в "…" (кавычки
 * внутри удвоены). Дальше — угадываем, где заголовок и какая колонка
 * что значит (телефон, имя, товар…), менеджер может поправить.
 */

export type PasteRole =
  | "skip"
  | "full_name"
  | "phone"
  | "phone_alt"
  | "product_hint"
  | "has_card"
  | "comment";

export const PASTE_ROLES: PasteRole[] = [
  "full_name",
  "phone",
  "phone_alt",
  "product_hint",
  "has_card",
  "comment",
  "skip",
];

export interface PasteTable {
  /** Header cells when the first line looks like a header, else null. */
  header: string[] | null;
  /** Data rows, every row padded to `width`. */
  rows: string[][];
  width: number;
}

export interface PasteRow {
  full_name: string;
  phone: string;
  phone_alt: string;
  product_hint: string;
  has_card: string;
  comment: string;
}

/** Split clipboard text into cells, honouring "…" quoting. */
export function parseTsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  const n = text.length;
  let atCellStart = true;
  while (i < n) {
    const ch = text[i];
    if (atCellStart && ch === '"') {
      // quoted cell: read up to the closing quote, "" is a literal quote
      i += 1;
      let closed = false;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        cell += text[i];
        i += 1;
      }
      if (!closed) {
        // not really a quoted cell (a lone quote at the start) — keep it
        cell = '"' + cell;
      }
      atCellStart = false;
      continue;
    }
    atCellStart = false;
    if (ch === "\t") {
      row.push(cell);
      cell = "";
      atCellStart = true;
    } else if (ch === "\n" || ch === "\r") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
      atCellStart = true;
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

/** Uzbek mobile number, the way it is written in sheets (+998…, 90 123…). */
export function isPhoneLike(raw: string): boolean {
  const s = raw.trim().replace(/^(?:p:|tel:)/i, "").replace(/^'/, "");
  if (!s || !/^[\d\s+\-()]+$/.test(s)) return false;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 9) return true;
  return digits.length === 12 && digits.startsWith("998");
}

const PRODUCT_RE =
  /(iphone|айфон|ayfon|samsung|самсунг|galaxy|redmi|xiaomi|ксиоми|poco|honor|хонор|huawei|realme|tecno|vivo|oppo|infinix|pixel|nokia|apple|hamyonbop|телефон|telefon|\bpro\b|\bmax\b|\bultra\b|(?:^|[\s\d])(?:про|мах|макс)(?=[\s\d]|$))/i;

const HEADER_HINTS: Array<[PasteRole, RegExp]> = [
  ["phone_alt", /(доп.*тел|qo.?shimcha|alt.*phone|phone.?alt|второй)/i],
  ["has_card", /(карт|karta|kartasi|card)/i],
  ["comment", /(коммент|izoh|comment|примеч|заметк)/i],
  ["full_name", /(^|\b)(имя|фио|ism|ismi|name|full.?name|mijoz|клиент)(\b|$)/i],
  ["product_hint", /(хочет|товар|модел|model|rusum|product|qanday.*telefon|xarid)/i],
  [
    "skip",
    /(дата|date|vaqt|время|статус|status|оператор|operator|sotuvchi|источник|source|ссылка|link|crm|qayerdan|yosh|возраст)/i,
  ],
];

const CARD_VALUE_RE = /^(ha|xa|yo'?q|yoq|bor|есть|нет|да|yes|no|\+|-|ha_|yo'q_)$/i;

function headerRole(cell: string): PasteRole | null {
  const h = cell.toLowerCase().replace(/^\s*\d+\s*[.)]\s*/, "").trim();
  if (!h) return null;
  for (const [role, re] of HEADER_HINTS) if (re.test(h)) return role;
  return null;
}

function looksLikeHeader(first: string[], rest: string[][]): boolean {
  if (first.some((c) => isPhoneLike(c))) return false;
  if (first.some((c) => headerRole(c) !== null && headerRole(c) !== "skip")) return true;
  // no phone (nor any long number) in the first line while the next lines carry phones
  if (first.some((c) => c.replace(/\D/g, "").length >= 7)) return false;
  const sample = rest.slice(0, 20);
  return sample.length > 0 && sample.filter((r) => r.some((c) => isPhoneLike(c))).length >= sample.length / 2;
}

/** Clipboard text → table (header split off, empty lines dropped, padded). */
export function splitPaste(text: string): PasteTable {
  const all = parseTsv(text)
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ""));
  const width = all.reduce((m, r) => Math.max(m, r.length), 0);
  const padded = all.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill("")] : r));
  if (padded.length > 1 && looksLikeHeader(padded[0], padded.slice(1))) {
    return { header: padded[0], rows: padded.slice(1), width };
  }
  return { header: null, rows: padded, width };
}

function ratio(rows: string[][], col: number, test: (v: string) => boolean): number {
  const vals = rows.map((r) => r[col] ?? "").filter((v) => v !== "");
  if (vals.length === 0) return 0;
  return vals.filter(test).length / vals.length;
}

const isNameLike = (v: string) =>
  /\p{L}/u.test(v) && !/\d/.test(v) && v.split(/\s+/).length <= 4 && !PRODUCT_RE.test(v);

/** Guess a role per column: phone by content, the rest by header, then content. */
export function guessRoles(table: PasteTable): PasteRole[] {
  const { rows, width, header } = table;
  const roles: PasteRole[] = Array(width).fill("skip");
  const sample = rows.slice(0, 200);
  const free = (c: number) => roles[c] === "skip";

  const phoneScores = Array.from({ length: width }, (_, c) => ratio(sample, c, isPhoneLike));
  const phoneCounts = Array.from(
    { length: width },
    (_, c) => sample.filter((r) => isPhoneLike(r[c] ?? "")).length,
  );
  const altByHeader = (c: number) => !!header && headerRole(header[c]) === "phone_alt";
  // main phone: the column with the most numbers (a mostly empty «Доп.
  // телефон» is 100 % phones too), a column titled as the extra one last
  const phoneCols = phoneScores
    .map((s, c) => ({ s, c }))
    .filter((x) => x.s >= 0.5)
    .sort(
      (a, b) =>
        Number(altByHeader(a.c)) - Number(altByHeader(b.c)) ||
        phoneCounts[b.c] - phoneCounts[a.c] ||
        a.c - b.c,
    );
  if (phoneCols[0]) roles[phoneCols[0].c] = "phone";

  const taken = new Set<PasteRole>(["phone"]);
  if (header) {
    header.forEach((cell, c) => {
      if (!free(c)) return;
      const role = headerRole(cell);
      if (!role || role === "skip") return;
      if (role === "phone_alt" && phoneScores[c] === 0 && sample.some((r) => r[c])) return;
      if (taken.has(role)) return;
      roles[c] = role;
      taken.add(role);
    });
  }
  // a second phone-only column (often «Доп. телефон», mostly empty)
  if (!taken.has("phone_alt")) {
    const alt = phoneCols.find((x) => free(x.c) && !(header && headerRole(header[x.c]) === "skip"));
    if (alt) {
      roles[alt.c] = "phone_alt";
      taken.add("phone_alt");
    }
  }
  const skipByHeader = (c: number) => !!header && headerRole(header[c]) === "skip";
  const pickBest = (role: PasteRole, test: (v: string) => boolean, min: number) => {
    if (taken.has(role)) return;
    let best = -1;
    let bestScore = min;
    for (let c = 0; c < width; c++) {
      if (!free(c) || skipByHeader(c)) continue;
      const s = ratio(sample, c, test);
      if (s >= bestScore && (best < 0 || s > bestScore)) {
        best = c;
        bestScore = s;
      }
    }
    if (best >= 0) {
      roles[best] = role;
      taken.add(role);
    }
  };
  pickBest("product_hint", (v) => PRODUCT_RE.test(v), 0.3);
  pickBest("full_name", isNameLike, 0.5);
  pickBest("has_card", (v) => CARD_VALUE_RE.test(v), 0.7);
  return roles;
}

/** Table + column roles → rows for the API (several columns of one role are joined). */
export function buildRows(table: PasteTable, roles: PasteRole[]): PasteRow[] {
  return table.rows.map((cells) => {
    const row: PasteRow = {
      full_name: "",
      phone: "",
      phone_alt: "",
      product_hint: "",
      has_card: "",
      comment: "",
    };
    roles.forEach((role, c) => {
      if (role === "skip") return;
      const v = (cells[c] ?? "").trim();
      if (!v) return;
      if (role === "phone" || role === "phone_alt") {
        if (!row[role]) row[role] = v;
        return;
      }
      row[role] = row[role] ? `${row[role]} · ${v}` : v;
    });
    return row;
  });
}
