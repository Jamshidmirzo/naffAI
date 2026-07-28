import { Navigate, Route, Routes } from "react-router-dom";
import AppShell from "./components/layout/AppShell";
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
import LeadStatuses from "./pages/LeadStatuses";
import Profile from "./pages/Profile";
import AIChat from "./pages/AIChat";
import Marketing from "./pages/Marketing";
import DailyLesson from "./pages/DailyLesson";
import LessonsHistory from "./pages/LessonsHistory";
import Scan from "./pages/Scan";
import AttendanceToday from "./pages/AttendanceToday";
import AttendanceReport from "./pages/AttendanceReport";
import Placeholder from "./pages/Placeholder";
import Notifications from "./pages/Notifications";
import SalesToday from "./pages/SalesToday";
import Reports from "./pages/Reports";
import TgQueue from "./pages/TgQueue";
import Users from "./pages/Users";
import { useAuth } from "./store/auth";
import { RoleGate, normaliseRole } from "./components/RoleGate";
import { ToastHost } from "./components/ui";

function Protected({ children }: { children: React.ReactNode }) {
  const token = useAuth((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RoleAwareHome() {
  const role = normaliseRole(useAuth((s) => s.role));
  if (role === "operator") return <Navigate to="/my" replace />;
  return <Dashboard />;
}

export default function App() {
  return (
    <>
      <ToastHost />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/scan" element={<Scan />} />
        <Route path="/screen" element={<Protected><Screen /></Protected>} />
        <Route
          element={
            <Protected>
              <AppShell />
            </Protected>
          }
        >
          <Route path="/" element={<RoleAwareHome />} />
          <Route path="/my" element={<MyLeads />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/lessons/today" element={<DailyLesson />} />
          <Route path="/lessons/history" element={<LessonsHistory />} />
          <Route path="/leads" element={<RoleGate allow={["manager"]}><Leads /></RoleGate>} />
          <Route path="/calls" element={<RoleGate allow={["manager"]}><Placeholder title="Звонки" /></RoleGate>} />
          <Route path="/reports" element={<RoleGate allow={["manager"]}><Reports /></RoleGate>} />
          <Route path="/catalog" element={<RoleGate allow={["manager"]}><Placeholder title="Каталог / TAC" /></RoleGate>} />
          <Route path="/stickers" element={<RoleGate allow={["manager"]}><Placeholder title="Стикеры" /></RoleGate>} />
          <Route path="/users" element={<RoleGate allow={["manager"]}><Users /></RoleGate>} />
          <Route path="/sales-today" element={<RoleGate allow={["manager"]}><SalesToday /></RoleGate>} />
          <Route path="/tg-queue" element={<RoleGate allow={["manager"]}><TgQueue /></RoleGate>} />
          <Route path="/sheet-sources" element={<RoleGate allow={["manager"]}><SheetSources /></RoleGate>} />
          <Route path="/statuses" element={<RoleGate allow={["manager"]}><LeadStatuses /></RoleGate>} />
          <Route path="/sales" element={<RoleGate allow={["manager"]}><Sales /></RoleGate>} />
          <Route path="/sales/new" element={<RoleGate allow={["manager"]}><SaleCreate /></RoleGate>} />
          <Route path="/sales/:id" element={<RoleGate allow={["manager"]}><SaleDetail /></RoleGate>} />
          <Route path="/sales/:id/edit" element={<RoleGate allow={["manager"]}><SaleCreate /></RoleGate>} />
          <Route path="/operators" element={<RoleGate allow={["manager"]}><Operators /></RoleGate>} />
          <Route path="/operators/:id" element={<RoleGate allow={["manager"]}><OperatorDetail /></RoleGate>} />
          <Route path="/partners" element={<RoleGate allow={["manager"]}><Partners /></RoleGate>} />
          <Route path="/analytics" element={<RoleGate allow={["manager"]}><Analytics /></RoleGate>} />
          <Route path="/payroll" element={<RoleGate allow={["manager"]}><Payroll /></RoleGate>} />
          <Route path="/audit" element={<RoleGate allow={["manager"]}><Audit /></RoleGate>} />
          <Route path="/ai-chat" element={<RoleGate allow={["manager"]}><AIChat /></RoleGate>} />
          <Route path="/marketing" element={<RoleGate allow={["manager"]}><Marketing /></RoleGate>} />
          <Route path="/attendance/today" element={<RoleGate allow={["manager"]}><AttendanceToday /></RoleGate>} />
          <Route path="/attendance/report" element={<RoleGate allow={["manager"]}><AttendanceReport /></RoleGate>} />
        </Route>
      </Routes>
    </>
  );
}
