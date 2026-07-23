import { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../store/auth";

type Role = "manager" | "team_lead" | "operator";

interface Props {
  allow: Role[];
  children: ReactNode;
}

export function RoleGate({ allow, children }: Props) {
  const role = useAuth((s) => s.role) as Role | null;
  if (!role) return <Navigate to="/login" replace />;
  if (!allow.includes(role)) return <Navigate to="/my" replace />;
  return <>{children}</>;
}
