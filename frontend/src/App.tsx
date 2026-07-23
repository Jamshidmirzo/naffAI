import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Sales from "./pages/Sales";
import SaleCreate from "./pages/SaleCreate";
import SaleDetail from "./pages/SaleDetail";
import Operators from "./pages/Operators";
import OperatorDetail from "./pages/OperatorDetail";
import Partners from "./pages/Partners";
import Analytics from "./pages/Analytics";
import Payroll from "./pages/Payroll";
import Audit from "./pages/Audit";
import Screen from "./pages/Screen";
import Login from "./pages/Login";
import MyLeads from "./pages/MyLeads";
import Leads from "./pages/Leads";
import SheetSources from "./pages/SheetSources";
import Profile from "./pages/Profile";
import { useAuth } from "./store/auth";

function Protected({ children }: { children: React.ReactNode }) {
  const token = useAuth((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/**
 * Operators are locked to the workstation (`/my`) — they don't get a
 * separate landing page. Team leads and managers land on the dashboard.
 */
function RoleAwareHome() {
  const role = useAuth((s) => s.role);
  if (role === "operator") return <Navigate to="/my" replace />;
  return <Dashboard />;
}

/** Guard team-lead-only routes. Falls back to `/my` for operators. */
function TeamLeadOnly({ children }: { children: React.ReactNode }) {
  const role = useAuth((s) => s.role);
  if (role !== "team_lead" && role !== "manager") {
    return <Navigate to="/my" replace />;
  }
  return <>{children}</>;
}

import { RoleGate } from "./components/RoleGate";
import { Toaster } from "sonner";

export default function App() {
  return (
    <>
      <Toaster position="top-right" richColors />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/screen" element={<Protected><Screen /></Protected>} />
        <Route
          element={
            <Protected>
              <Layout />
            </Protected>
          }
        >
          <Route path="/" element={<RoleAwareHome />} />
          <Route path="/my" element={<MyLeads />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/leads" element={<RoleGate allow={["manager", "team_lead"]}><Leads /></RoleGate>} />
          <Route path="/sheet-sources" element={<RoleGate allow={["manager", "team_lead"]}><SheetSources /></RoleGate>} />
          <Route path="/sales" element={<RoleGate allow={["manager", "team_lead"]}><Sales /></RoleGate>} />
          <Route path="/sales/new" element={<RoleGate allow={["manager", "team_lead"]}><SaleCreate /></RoleGate>} />
          <Route path="/sales/:id" element={<RoleGate allow={["manager", "team_lead"]}><SaleDetail /></RoleGate>} />
          <Route path="/sales/:id/edit" element={<RoleGate allow={["manager", "team_lead"]}><SaleCreate /></RoleGate>} />
          <Route path="/operators" element={<RoleGate allow={["manager", "team_lead"]}><Operators /></RoleGate>} />
          <Route path="/operators/:id" element={<RoleGate allow={["manager", "team_lead"]}><OperatorDetail /></RoleGate>} />
          <Route path="/partners" element={<RoleGate allow={["manager", "team_lead"]}><Partners /></RoleGate>} />
          <Route path="/analytics" element={<RoleGate allow={["manager", "team_lead"]}><Analytics /></RoleGate>} />
          <Route path="/payroll" element={<RoleGate allow={["manager", "team_lead"]}><Payroll /></RoleGate>} />
          <Route path="/audit" element={<RoleGate allow={["manager"]}><Audit /></RoleGate>} />
        </Route>
      </Routes>
    </>
  );
}
