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
 * Backend stores three internal roles (`team_lead`, `manager`, `operator`),
 * but the product only exposes two — `team_lead` is the "senior manager"
 * with full write access, so we collapse it into `manager` for the UI.
 */
export function normaliseRole(raw: string | null | undefined): Role | null {
  if (raw === "operator") return "operator";
  if (raw === "manager" || raw === "team_lead") return "manager";
  return null;
}

export function RoleGate({ allow, children }: Props) {
  const rawRole = useAuth((s) => s.role);
  const role = normaliseRole(rawRole);
  if (!role) return <Navigate to="/login" replace />;
  if (!allow.includes(role)) return <Navigate to="/my" replace />;
  return <>{children}</>;
}
