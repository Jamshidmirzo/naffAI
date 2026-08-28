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
import LeadsStats from "./pages/LeadsStats";
import Payroll from "./pages/Payroll";
import Leaderboard from "./pages/Leaderboard";
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
import AttendancePhotos from "./pages/AttendancePhotos";
import AttendanceKiosk from "./pages/AttendanceKiosk";
import Placeholder from "./pages/Placeholder";
import Notifications from "./pages/Notifications";
import SalesToday from "./pages/SalesToday";
import Reports from "./pages/Reports";
import MyActivity from "./pages/MyActivity";
import TgQueue from "./pages/TgQueue";
import Users from "./pages/Users";
import Settings from "./pages/Settings";
import OrphanLeads from "./pages/OrphanLeads";
import OperatorSaleCreate from "./pages/OperatorSaleCreate";
import SalesPending from "./pages/SalesPending";
import BotConfig from "./pages/BotConfig";
import BotSubscribers from "./pages/BotSubscribers";
import Catalog from "./pages/Catalog";
import CatalogBanks from "./pages/CatalogBanks";
import Calculator from "./pages/Calculator";
import MarketingSettingsPage from "./pages/MarketingSettingsPage";
import InstallmentTiersPage from "./pages/InstallmentTiersPage";
import { useAuth } from "./store/auth";
import { RoleGate, normaliseRole } from "./components/RoleGate";
import PinGate from "./components/PinGate";
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
        {/* /kiosk = same public poster page as /scan (no ?qr=), separated
            path so future kiosk-specific behaviour has its own URL. */}
        <Route path="/kiosk" element={<Scan />} />
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
          <Route path="/my/sale-new" element={<RoleGate allow={["operator"]}><OperatorSaleCreate /></RoleGate>} />
          <Route path="/sales/pending" element={<RoleGate allow={["manager"]}><SalesPending /></RoleGate>} />
          <Route path="/bot" element={<RoleGate allow={["manager"]}><BotConfig /></RoleGate>} />
          <Route path="/bot-subscribers" element={<RoleGate allow={["manager"]}><BotSubscribers /></RoleGate>} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/lessons/today" element={<DailyLesson />} />
          <Route path="/lessons/history" element={<LessonsHistory />} />
          <Route path="/leads" element={<RoleGate allow={["manager"]}><Leads /></RoleGate>} />
          <Route path="/leads/orphans" element={<RoleGate allow={["manager"]}><OrphanLeads /></RoleGate>} />
          <Route path="/settings" element={<RoleGate allow={["manager"]}><Settings /></RoleGate>} />
          <Route path="/calls" element={<RoleGate allow={["manager"]}><Placeholder title="Звонки" /></RoleGate>} />
          <Route path="/reports" element={<RoleGate allow={["manager"]}><Reports /></RoleGate>} />
          <Route path="/my/activity" element={<RoleGate allow={["operator"]}><MyActivity /></RoleGate>} />
          <Route path="/catalog" element={<RoleGate allow={["manager", "operator"]}><Catalog /></RoleGate>} />
          <Route path="/catalog/banks" element={<RoleGate allow={["manager"]}><CatalogBanks /></RoleGate>} />
          <Route path="/catalog/marketing-settings" element={<RoleGate allow={["manager"]}><MarketingSettingsPage /></RoleGate>} />
          <Route path="/catalog/tiers" element={<RoleGate allow={["manager"]}><InstallmentTiersPage /></RoleGate>} />
          <Route path="/calculator" element={<RoleGate allow={["manager", "operator"]}><Calculator /></RoleGate>} />
          <Route path="/stickers" element={<RoleGate allow={["manager"]}><Placeholder title="Стикеры" /></RoleGate>} />
          <Route path="/users" element={<RoleGate allow={["manager"]}><Users /></RoleGate>} />
          <Route path="/sales-today" element={<RoleGate allow={["manager"]}><SalesToday /></RoleGate>} />
          <Route path="/tg-queue" element={<RoleGate allow={["manager"]}><TgQueue /></RoleGate>} />
          <Route path="/sheet-sources" element={<RoleGate allow={["manager"]}><SheetSources /></RoleGate>} />
          <Route path="/statuses" element={<RoleGate allow={["manager"]}><LeadStatuses /></RoleGate>} />
          <Route path="/sales" element={<RoleGate allow={["manager"]}><Sales /></RoleGate>} />
          <Route path="/sales/new" element={<RoleGate allow={["manager"]}><SaleCreate /></RoleGate>} />
          <Route path="/sales/:id" element={<SaleDetail />} />
          <Route path="/sales/:id/edit" element={<RoleGate allow={["manager"]}><SaleCreate /></RoleGate>} />
          <Route path="/operators" element={<RoleGate allow={["manager"]}><Operators /></RoleGate>} />
          <Route path="/operators/:id" element={<RoleGate allow={["manager"]}><OperatorDetail /></RoleGate>} />
          <Route path="/partners" element={<RoleGate allow={["manager"]}><Partners /></RoleGate>} />
          <Route path="/analytics" element={<RoleGate allow={["manager"]}><Analytics /></RoleGate>} />
          <Route path="/leads-stats" element={<RoleGate allow={["manager"]}><LeadsStats /></RoleGate>} />
          <Route path="/payroll" element={<RoleGate allow={["manager"]}><Payroll /></RoleGate>} />
          <Route path="/leaderboard" element={<RoleGate allow={["manager", "operator"]}><Leaderboard /></RoleGate>} />
          <Route path="/audit" element={<RoleGate allow={["manager"]}><Audit /></RoleGate>} />
          <Route path="/ai-chat" element={<RoleGate allow={["manager"]}><AIChat /></RoleGate>} />
          <Route path="/marketing" element={<RoleGate allow={["manager"]}><Marketing /></RoleGate>} />
          <Route path="/attendance/today" element={<RoleGate allow={["manager"]}><PinGate><AttendanceToday /></PinGate></RoleGate>} />
          <Route path="/attendance/report" element={<RoleGate allow={["manager"]}><PinGate><AttendanceReport /></PinGate></RoleGate>} />
          <Route path="/attendance/photos" element={<RoleGate allow={["manager"]}><PinGate><AttendancePhotos /></PinGate></RoleGate>} />
          <Route path="/attendance/kiosk" element={<RoleGate allow={["manager"]}><PinGate><AttendanceKiosk /></PinGate></RoleGate>} />
        </Route>
      </Routes>
    </>
  );
}
