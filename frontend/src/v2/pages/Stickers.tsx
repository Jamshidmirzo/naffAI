import { Navigate } from "react-router-dom";

/** «Стикеры» is a placeholder in the old app; removed from the new menu. */
export default function Stickers() {
  return <Navigate to="/operators" replace />;
}
