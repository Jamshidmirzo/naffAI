import { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../store/auth";

type Role = "manager" | "super_manager" | "operator";

interface Props {
  allow: Role[];
  children: ReactNode;
}

/**
 * Normalise backend role strings to the UI-facing roles.
 *
 * Backend stores several internal roles (`team_lead`, `manager`,
 * `super_manager`, `operator`, `superadmin`); the product exposes three:
 *   - operator       — рядовой оператор
 *   - manager        — все «senior»-роли без иерархии: team_lead / manager
 *                      / superadmin сворачиваются сюда
 *   - super_manager  — middle-tier владелец (видит scope-ed статистику
 *                      по своей ветке, свои страницы /team/*)
 *
 * Superadmin отличается только пунктом «Фото сотрудников» / «Системно
 * потерянные» в nav — проверка идёт через `isSuperadmin()`. На уровне
 * нормализованной роли он остаётся "manager" (видит всё, что manager).
 */
export function normaliseRole(raw: string | null | undefined): Role | null {
  if (raw === "operator") return "operator";
  if (raw === "super_manager") return "super_manager";
  if (raw === "manager" || raw === "team_lead" || raw === "superadmin")
    return "manager";
  return null;
}

/** True если raw-роль = "superadmin" (для показа фото-галереи в nav). */
export function isSuperadmin(raw: string | null | undefined): boolean {
  return raw === "superadmin";
}

/** True если raw-роль = "super_manager" (новая middle-tier роль). */
export function isSuperManager(raw: string | null | undefined): boolean {
  return raw === "super_manager";
}

export function RoleGate({ allow, children }: Props) {
  const rawRole = useAuth((s) => s.role);
  const role = normaliseRole(rawRole);
  if (!role) return <Navigate to="/login" replace />;
  if (!allow.includes(role)) {
    // Role-aware fallback: operator → /my, остальные (manager /
    // super_manager) → /. Super_manager не отправляем на /my, у него
    // нет operator-FK, страница пустая.
    return <Navigate to={role === "operator" ? "/my" : "/"} replace />;
  }
  return <>{children}</>;
}

/**
 * Жёсткий гейт только для superadmin (не manager!). Используется для
 * страниц типа /leads/system-lost, где massovая случайная кнопка
 * «восстановить» неопытным менеджером может вернуть в раздачу
 * 3-месячные мёртвые контакты. RoleGate свернул бы superadmin в
 * manager — нам нужен именно raw check.
 */
export function SuperadminGate({ children }: { children: ReactNode }) {
  const rawRole = useAuth((s) => s.role);
  if (!isSuperadmin(rawRole)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
