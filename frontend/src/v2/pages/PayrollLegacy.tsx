import { Navigate } from "react-router-dom";

/** Old sales-bonus payroll: in the new design there is one «Зарплата» — /attendance/payroll. */
export default function PayrollLegacy() {
  return <Navigate to="/attendance/payroll" replace />;
}
