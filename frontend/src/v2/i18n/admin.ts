/** v2 strings for the admin zone, merged from ./admin/<group>.ts (keys v2.admin.*). */
import analytics from "./admin/analytics";
import marketing from "./admin/marketing";
import sheets from "./admin/sheets";
import settings from "./admin/settings";
import bot from "./admin/bot";

const parts = [analytics, marketing, sheets, settings, bot];

export default {
  ru: Object.assign({}, ...parts.map((p) => p.ru)) as Record<string, string>,
  uz: Object.assign({}, ...parts.map((p) => p.uz)) as Record<string, string>,
};
