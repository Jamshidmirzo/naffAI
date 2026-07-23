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

export default function App() {
  return (
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
        <Route path="/leads" element={<TeamLeadOnly><Leads /></TeamLeadOnly>} />
        <Route path="/sheet-sources" element={<TeamLeadOnly><SheetSources /></TeamLeadOnly>} />
        <Route path="/sales" element={<TeamLeadOnly><Sales /></TeamLeadOnly>} />
        <Route path="/sales/new" element={<TeamLeadOnly><SaleCreate /></TeamLeadOnly>} />
        <Route path="/sales/:id" element={<TeamLeadOnly><SaleDetail /></TeamLeadOnly>} />
        <Route path="/sales/:id/edit" element={<TeamLeadOnly><SaleCreate /></TeamLeadOnly>} />
        <Route path="/operators" element={<TeamLeadOnly><Operators /></TeamLeadOnly>} />
        <Route path="/operators/:id" element={<TeamLeadOnly><OperatorDetail /></TeamLeadOnly>} />
        <Route path="/partners" element={<TeamLeadOnly><Partners /></TeamLeadOnly>} />
        <Route path="/analytics" element={<TeamLeadOnly><Analytics /></TeamLeadOnly>} />
        <Route path="/payroll" element={<TeamLeadOnly><Payroll /></TeamLeadOnly>} />
        <Route path="/audit" element={<TeamLeadOnly><Audit /></TeamLeadOnly>} />
      </Route>
    </Routes>
  );
}
