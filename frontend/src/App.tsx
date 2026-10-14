import { Navigate, Route, Routes } from "react-router-dom";
import { ShellSwitch } from "./v2/shell/ShellSwitch";
import { Pick } from "./v2/registry";
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
import MarketingSources from "./pages/MarketingSources";
import DailyLesson from "./pages/DailyLesson";
import LessonsHistory from "./pages/LessonsHistory";
import TrainingList from "./pages/TrainingList";
import TrainingLessonView from "./pages/TrainingLessonView";
import TrainingManage from "./pages/TrainingManage";
import TrainingLessonForm from "./pages/TrainingLessonForm";
import Scan from "./pages/Scan";
import AttendanceToday from "./pages/AttendanceToday";
import AttendanceReport from "./pages/AttendanceReport";
import AttendancePhotos from "./pages/AttendancePhotos";
import AttendanceKiosk from "./pages/AttendanceKiosk";
import PayrollReport from "./pages/PayrollReport";
import AttendanceSettings from "./pages/AttendanceSettings";
import MyPayroll from "./pages/MyPayroll";
import MySales from "./pages/MySales";
import MyDayOff from "./pages/MyDayOff";
import DayOffRequests from "./pages/DayOffRequests";
import Placeholder from "./pages/Placeholder";
import Notifications from "./pages/Notifications";
import SalesToday from "./pages/SalesToday";
import Reports from "./pages/Reports";
import MyActivity from "./pages/MyActivity";
import TgQueue from "./pages/TgQueue";
import Users from "./pages/Users";
import MyManagers from "./pages/MyManagers";
import MyTeamSales from "./pages/MyTeamSales";
import DeletedOperators from "./pages/DeletedOperators";
import Settings from "./pages/Settings";
import OrphanLeads from "./pages/OrphanLeads";
import SystemLostLeads from "./pages/SystemLostLeads";
import OperatorSaleCreate from "./pages/OperatorSaleCreate";
import SalesPending from "./pages/SalesPending";
import BotConfig from "./pages/BotConfig";
import BotSubscribers from "./pages/BotSubscribers";
import Catalog from "./pages/Catalog";
import CatalogBanks from "./pages/CatalogBanks";
import Calculator from "./pages/Calculator";
import Calls from "./pages/Calls";
import MarketingSettingsPage from "./pages/MarketingSettingsPage";
import InstallmentTiersPage from "./pages/InstallmentTiersPage";
import LiveWall from "./pages/LiveWall";
import LiveArchive from "./pages/LiveArchive";
import { useAuth } from "./store/auth";
import { RoleGate, SuperadminGate, normaliseRole } from "./components/RoleGate";
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
  if (role === "super_manager") return <Navigate to="/team/sales" replace />;
  return <Dashboard />;
}

export default function App() {
  return (
    <>
      <ToastHost />
      <Routes>
        <Route path="/login" element={<Pick k="/login" v1={<Login />} />} />
        <Route path="/scan" element={<Pick k="/scan" v1={<Scan />} />} />
        {/* /kiosk = same public poster page as /scan (no ?qr=), separated
            path so future kiosk-specific behaviour has its own URL. */}
        <Route path="/kiosk" element={<Pick k="/kiosk" v1={<Scan />} />} />
        <Route path="/screen" element={<Protected><Pick k="/screen" v1={<Screen />} /></Protected>} />
        <Route
          element={
            <Protected>
              <ShellSwitch />
            </Protected>
          }
        >
          <Route path="/" element={<Pick k="/" v1={<RoleAwareHome />} />} />
          <Route path="/my" element={<Pick k="/my" v1={<MyLeads />} />} />
          <Route path="/my/sale-new" element={<RoleGate allow={["operator"]}><Pick k="/my/sale-new" v1={<OperatorSaleCreate />} /></RoleGate>} />
          <Route path="/sales/pending" element={<RoleGate allow={["manager"]}><Pick k="/sales/pending" v1={<SalesPending />} /></RoleGate>} />
          <Route path="/bot" element={<RoleGate allow={["manager"]}><Pick k="/bot" v1={<BotConfig />} /></RoleGate>} />
          <Route path="/bot-subscribers" element={<RoleGate allow={["manager"]}><Pick k="/bot-subscribers" v1={<BotSubscribers />} /></RoleGate>} />
          <Route path="/profile" element={<Pick k="/profile" v1={<Profile />} />} />
          <Route path="/notifications" element={<Pick k="/notifications" v1={<Notifications />} />} />
          <Route path="/lessons/today" element={<Pick k="/lessons/today" v1={<DailyLesson />} />} />
          <Route path="/lessons/history" element={<Pick k="/lessons/history" v1={<LessonsHistory />} />} />
          {/* Обучение (manager-authored) — /training. Не путать с /lessons/*,
              там AI-generated DailyLesson. */}
          <Route path="/training" element={<Pick k="/training" v1={<TrainingList />} />} />
          <Route path="/training/:id" element={<Pick k="/training/:id" v1={<TrainingLessonView />} />} />
          <Route
            path="/training/manage"
            element={<RoleGate allow={["manager"]}><Pick k="/training/manage" v1={<TrainingManage />} /></RoleGate>}
          />
          <Route
            path="/training/manage/new"
            element={<RoleGate allow={["manager"]}><Pick k="/training/manage/new" v1={<TrainingLessonForm />} /></RoleGate>}
          />
          <Route
            path="/training/manage/:id"
            element={<RoleGate allow={["manager"]}><Pick k="/training/manage/:id" v1={<TrainingLessonForm />} /></RoleGate>}
          />
          <Route path="/leads" element={<RoleGate allow={["manager"]}><Pick k="/leads" v1={<Leads />} /></RoleGate>} />
          <Route path="/leads/orphans" element={<RoleGate allow={["manager"]}><Pick k="/leads/orphans" v1={<OrphanLeads />} /></RoleGate>} />
          <Route path="/leads/system-lost" element={<SuperadminGate><Pick k="/leads/system-lost" v1={<SystemLostLeads />} /></SuperadminGate>} />
          <Route path="/settings" element={<RoleGate allow={["manager"]}><Pick k="/settings" v1={<Settings />} /></RoleGate>} />
          <Route path="/calls" element={<RoleGate allow={["manager"]}><Pick k="/calls" v1={<Calls />} /></RoleGate>} />
          <Route path="/reports" element={<RoleGate allow={["manager"]}><Pick k="/reports" v1={<Reports />} /></RoleGate>} />
          <Route path="/my/activity" element={<RoleGate allow={["operator"]}><Pick k="/my/activity" v1={<MyActivity />} /></RoleGate>} />
          <Route path="/catalog" element={<RoleGate allow={["manager", "operator"]}><Pick k="/catalog" v1={<Catalog />} /></RoleGate>} />
          <Route path="/catalog/banks" element={<RoleGate allow={["manager"]}><Pick k="/catalog/banks" v1={<CatalogBanks />} /></RoleGate>} />
          <Route path="/catalog/marketing-settings" element={<RoleGate allow={["manager"]}><Pick k="/catalog/marketing-settings" v1={<MarketingSettingsPage />} /></RoleGate>} />
          <Route path="/catalog/tiers" element={<RoleGate allow={["manager"]}><Pick k="/catalog/tiers" v1={<InstallmentTiersPage />} /></RoleGate>} />
          <Route path="/calculator" element={<RoleGate allow={["manager", "operator"]}><Pick k="/calculator" v1={<Calculator />} /></RoleGate>} />
          <Route path="/stickers" element={<RoleGate allow={["manager"]}><Pick k="/stickers" v1={<Placeholder title="Стикеры" />} /></RoleGate>} />
          <Route path="/users" element={<RoleGate allow={["manager"]}><Pick k="/users" v1={<Users />} /></RoleGate>} />
          {/* 2026-10-06: super_manager admin pages. Поддоменом /team/* чтобы
              не коллизировать с существующими /sales / /operators (их тоже
              даём super_manager'у, но scope-ed данные через backend
              visible_operator_ids). */}
          <Route path="/team/managers" element={<RoleGate allow={["super_manager"]}><Pick k="/team/managers" v1={<MyManagers />} /></RoleGate>} />
          <Route path="/team/operators" element={<RoleGate allow={["super_manager"]}><Pick k="/team/operators" v1={<Operators />} /></RoleGate>} />
          <Route path="/team/sales" element={<RoleGate allow={["super_manager"]}><Pick k="/team/sales" v1={<MyTeamSales />} /></RoleGate>} />
          <Route path="/team/deleted-operators" element={<RoleGate allow={["super_manager"]}><Pick k="/team/deleted-operators" v1={<DeletedOperators />} /></RoleGate>} />
          <Route path="/sales-today" element={<RoleGate allow={["manager"]}><Pick k="/sales-today" v1={<SalesToday />} /></RoleGate>} />
          <Route path="/tg-queue" element={<RoleGate allow={["manager"]}><Pick k="/tg-queue" v1={<TgQueue />} /></RoleGate>} />
          <Route path="/sheet-sources" element={<RoleGate allow={["manager"]}><Pick k="/sheet-sources" v1={<SheetSources />} /></RoleGate>} />
          <Route path="/statuses" element={<RoleGate allow={["manager"]}><Pick k="/statuses" v1={<LeadStatuses />} /></RoleGate>} />
          <Route path="/sales" element={<RoleGate allow={["manager"]}><Pick k="/sales" v1={<Sales />} /></RoleGate>} />
          <Route path="/sales/new" element={<RoleGate allow={["manager"]}><Pick k="/sales/new" v1={<SaleCreate />} /></RoleGate>} />
          <Route path="/sales/:id" element={<Pick k="/sales/:id" v1={<SaleDetail />} />} />
          <Route path="/sales/:id/edit" element={<RoleGate allow={["manager"]}><Pick k="/sales/:id/edit" v1={<SaleCreate />} /></RoleGate>} />
          <Route path="/operators" element={<RoleGate allow={["manager"]}><Pick k="/operators" v1={<Operators />} /></RoleGate>} />
          <Route path="/operators/:id" element={<RoleGate allow={["manager"]}><Pick k="/operators/:id" v1={<OperatorDetail />} /></RoleGate>} />
          <Route path="/partners" element={<RoleGate allow={["manager"]}><Pick k="/partners" v1={<Partners />} /></RoleGate>} />
          <Route path="/analytics" element={<RoleGate allow={["manager"]}><Pick k="/analytics" v1={<Analytics />} /></RoleGate>} />
          <Route path="/leads-stats" element={<RoleGate allow={["manager"]}><Pick k="/leads-stats" v1={<LeadsStats />} /></RoleGate>} />
          <Route path="/payroll" element={<RoleGate allow={["manager"]}><Pick k="/payroll" v1={<Payroll />} /></RoleGate>} />
          <Route path="/leaderboard" element={<RoleGate allow={["manager", "operator"]}><Pick k="/leaderboard" v1={<Leaderboard />} /></RoleGate>} />
          <Route path="/audit" element={<RoleGate allow={["manager"]}><Pick k="/audit" v1={<Audit />} /></RoleGate>} />
          <Route path="/ai-chat" element={<RoleGate allow={["manager"]}><Pick k="/ai-chat" v1={<AIChat />} /></RoleGate>} />
          <Route path="/marketing" element={<RoleGate allow={["manager"]}><Pick k="/marketing" v1={<Marketing />} /></RoleGate>} />
          <Route path="/marketing/sources" element={<RoleGate allow={["manager"]}><Pick k="/marketing/sources" v1={<MarketingSources />} /></RoleGate>} />
          <Route path="/attendance/today" element={<RoleGate allow={["manager"]}><PinGate><Pick k="/attendance/today" v1={<AttendanceToday />} /></PinGate></RoleGate>} />
          <Route path="/attendance/report" element={<RoleGate allow={["manager"]}><PinGate><Pick k="/attendance/report" v1={<AttendanceReport />} /></PinGate></RoleGate>} />
          <Route path="/attendance/photos" element={<RoleGate allow={["manager"]}><PinGate><Pick k="/attendance/photos" v1={<AttendancePhotos />} /></PinGate></RoleGate>} />
          <Route path="/attendance/kiosk" element={<RoleGate allow={["manager"]}><PinGate><Pick k="/attendance/kiosk" v1={<AttendanceKiosk />} /></PinGate></RoleGate>} />
          {/* 2026-08-31 attendance-based payroll. Manager: сводка по всем
              операторам + drilldown + Excel/PDF per-operator. PinGate,
              как и остальные /attendance/* — совпадает с backend
              permission IsAttendancePinVerified. */}
          <Route path="/attendance/payroll" element={<RoleGate allow={["manager"]}><PinGate><Pick k="/attendance/payroll" v1={<PayrollReport />} /></PinGate></RoleGate>} />
          {/* Operator: свой отчёт за месяц (PIN не нужен, backend уже
              фильтрует по profile.operator). */}
          <Route path="/my/payroll" element={<RoleGate allow={["operator"]}><Pick k="/my/payroll" v1={<MyPayroll />} /></RoleGate>} />
          <Route path="/my/sales" element={<RoleGate allow={["operator"]}><Pick k="/my/sales" v1={<MySales />} /></RoleGate>} />
          <Route path="/my/day-off" element={<RoleGate allow={["operator"]}><Pick k="/my/day-off" v1={<MyDayOff />} /></RoleGate>} />
          <Route path="/operators/day-off" element={<RoleGate allow={["manager"]}><Pick k="/operators/day-off" v1={<DayOffRequests />} /></RoleGate>} />
          <Route path="/settings/attendance" element={<RoleGate allow={["manager"]}><PinGate><Pick k="/settings/attendance" v1={<AttendanceSettings />} /></PinGate></RoleGate>} />
          {/* 2026-10-08 — WebRTC live-эфир. Manager-only. */}
          <Route path="/live/wall" element={<RoleGate allow={["manager"]}><Pick k="/live/wall" v1={<LiveWall />} /></RoleGate>} />
          <Route path="/live/archive" element={<RoleGate allow={["manager"]}><Pick k="/live/archive" v1={<LiveArchive />} /></RoleGate>} />
          <Route path="*" element={<Pick k="*" v1={null} />} />
        </Route>
      </Routes>
    </>
  );
}
