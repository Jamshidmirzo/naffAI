import { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../store/auth";

type Role = "manager" | "operator";

interface Props {
  allow: Role[];
  children: ReactNode;
}

/**
 * Normalise backend role strings to the two UI-facing roles.
 * Backend stores several internal roles (`team_lead`, `manager`, `operator`,
 * `superadmin`), but the product exposes two — все senior-роли (team_lead /
 * manager / superadmin) сворачиваются в `manager`, чтобы навигация и права
 * в UI были одинаковые. Superadmin отличается только дополнительным
 * пунктом «Фото сотрудников» — эта проверка идёт через `isSuperadmin()`.
 */
export function normaliseRole(raw: string | null | undefined): Role | null {
  if (raw === "operator") return "operator";
  if (raw === "manager" || raw === "team_lead" || raw === "superadmin")
    return "manager";
  return null;
}

/** True если raw-роль = "superadmin" (для показа фото-галереи в nav). */
export function isSuperadmin(raw: string | null | undefined): boolean {
  return raw === "superadmin";
}

export function RoleGate({ allow, children }: Props) {
  const rawRole = useAuth((s) => s.role);
  const role = normaliseRole(rawRole);
  if (!role) return <Navigate to="/login" replace />;
  if (!allow.includes(role)) return <Navigate to="/my" replace />;
  return <>{children}</>;
}
