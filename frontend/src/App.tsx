import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Sales from "./pages/Sales";
import SaleCreate from "./pages/SaleCreate";
import Operators from "./pages/Operators";
import Partners from "./pages/Partners";
import Analytics from "./pages/Analytics";
import Payroll from "./pages/Payroll";
import Audit from "./pages/Audit";
import Login from "./pages/Login";
import { useAuth } from "./store/auth";

function Protected({ children }: { children: React.ReactNode }) {
  const token = useAuth((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/sales" element={<Sales />} />
        <Route path="/sales/new" element={<SaleCreate />} />
        <Route path="/operators" element={<Operators />} />
        <Route path="/partners" element={<Partners />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/payroll" element={<Payroll />} />
        <Route path="/audit" element={<Audit />} />
      </Route>
    </Routes>
  );
}
