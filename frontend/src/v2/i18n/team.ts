/**
 * v2 strings for the «Команда / Смена / Обучение / Эфир» zone.
 * Split per page group under ./team/* (not globbed by index.ts — merged here).
 */
import operators from "./team/operators";
import operatorDetail from "./team/operatorDetail";
import people from "./team/people";
import attendance from "./team/attendance";
import payroll from "./team/payroll";
import trainingLive from "./team/trainingLive";

const parts = [operators, operatorDetail, people, attendance, payroll, trainingLive];

export default {
  ru: Object.assign({}, ...parts.map((p) => p.ru)) as Record<string, string>,
  uz: Object.assign({}, ...parts.map((p) => p.uz)) as Record<string, string>,
};
