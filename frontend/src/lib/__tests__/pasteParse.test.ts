// «Вставить и раздать»: разбор буфера из Google Sheets и угадывание колонок.
import { describe, expect, it } from "vitest";
import { buildRows, guessRoles, isPhoneLike, parseTsv, splitPaste } from "../pasteParse";

describe("parseTsv", () => {
  it("splits tabs and lines, keeps quoted cells with newlines and quotes", () => {
    const text = 'a\t"line1\nline2"\tc\r\n"say ""hi"""\t\tz\n';
    expect(parseTsv(text)).toEqual([
      ["a", "line1\nline2", "c"],
      ['say "hi"', "", "z"],
    ]);
  });

  it("keeps a lone leading quote as text", () => {
    expect(parseTsv('"abc')).toEqual([['"abc']]);
  });
});

describe("isPhoneLike", () => {
  it.each([
    ["+998 90 123 45 67", true],
    ["901234567", true],
    ["'+998901234567", true],
    ["p:+998901234567", true],
    ["(90) 123-45-67", true],
    ["2026-10-14 17:21", false],
    ["11.10 15:24", false],
    ["12345", false],
    ["+7 901 234 56 78", false],
  ])("%s → %s", (v, ok) => {
    expect(isPhoneLike(v)).toBe(ok);
  });
});

describe("splitPaste + guessRoles", () => {
  it("srm tab without a header: product, name, phone", () => {
    const t = splitPaste(
      "Hamyonbop\tSoliha Asqarova\t+998901112233\n" +
        "Айфон 17 про Макс\tТимур\t+998 93 444 55 66\n" +
        "Samsung\tShodiya\t770001122\n",
    );
    expect(t.header).toBeNull();
    expect(t.rows).toHaveLength(3);
    expect(guessRoles(t)).toEqual(["product_hint", "full_name", "phone"]);
  });

  it("CRM retry export with a header", () => {
    const t = splitPaste(
      "Дата статуса\tТелефон\tДоп. телефон\tИмя\tХочет купить\tКарта\tСтатус\tОператор\tКомментарий\n" +
        "11.10 15:24\t+998901112233\t\tNozim\tАйфон 15 про\tha\tJavob bermadi 1\tBonu\tqayta\n" +
        "12.10 10:00\t+998902223344\t+998933334455\tAli\tRedmi 13\t\tSMS\tMadina\t\n",
    );
    expect(t.header?.[1]).toBe("Телефон");
    expect(guessRoles(t)).toEqual([
      "skip",
      "phone",
      "phone_alt",
      "full_name",
      "product_hint",
      "has_card",
      "skip",
      "skip",
      "comment",
    ]);
  });

  it("a mostly empty extra-phone column does not win over the main phone", () => {
    const t = splitPaste(
      "Дата статуса\tТелефон\tДоп. телефон\tИмя\n" +
        "11.10 15:24\t+998901112233\t\tNozim\n" +
        "12.10 10:00\t+998902223344\t+998933334455\tAli\n" +
        "12.10 11:00\t12-34\t\tSoli\n",
    );
    expect(guessRoles(t).slice(0, 4)).toEqual(["skip", "phone", "phone_alt", "full_name"]);
    const noHeader = splitPaste(
      "Nozim\t+998901112233\t\nAli\t+998902223344\t+998933334455\nSoli\t12-34\t\n",
    );
    expect(guessRoles(noHeader)).toEqual(["full_name", "phone", "phone_alt"]);
  });

  it("Meta lead-form export", () => {
    const t = splitPaste(
      "1. Qayerdansiz\t2. Yoshingiz nechida\t4. Plastik kartangiz bormi ?\t5. Qanday telefon xarid qilmoqchisiz?\t6. Full name\t7. Phone number\n" +
        "toshkent_shahar\t19+\tha_\t15redmi\tDoʻstbekov Islom\t+998948887766\n",
    );
    expect(guessRoles(t)).toEqual(["skip", "skip", "has_card", "product_hint", "full_name", "phone"]);
  });

  it("does not take a first data row with a broken phone for a header", () => {
    const t = splitPaste("Ali\t9012345\nVali\t+998901112233\nSoli\t+998902223344\n");
    expect(t.header).toBeNull();
    expect(t.rows).toHaveLength(3);
  });

  it("drops empty lines and pads short rows", () => {
    const t = splitPaste("Ali\t+998901112233\tiPhone\n\n\t\t\nVali\t+998902223344\n");
    expect(t.rows).toEqual([
      ["Ali", "+998901112233", "iPhone"],
      ["Vali", "+998902223344", ""],
    ]);
  });
});

describe("buildRows", () => {
  it("maps roles and joins several columns of one role", () => {
    const t = splitPaste("Ali\t+998901112233\tiPhone 15\t256GB\tskipme\n");
    const rows = buildRows(t, ["full_name", "phone", "product_hint", "product_hint", "skip"]);
    expect(rows).toEqual([
      {
        full_name: "Ali",
        phone: "+998901112233",
        phone_alt: "",
        product_hint: "iPhone 15 · 256GB",
        has_card: "",
        comment: "",
      },
    ]);
  });
});
