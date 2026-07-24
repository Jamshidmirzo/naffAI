import { api } from "../lib/api";
import { useAuth } from "../store/auth";

export interface ScanResponse {
  action: "check_in" | "check_out";
  operator: {
    id: number;
    full_name: string;
  };
  token?: string;
  username?: string;
  role?: string;
  was_late?: boolean;
  checked_in_at?: string;
  checked_out_at?: string;
  duration_min?: number;
}

export function useAttendanceScan() {
  const setAuth = useAuth((s) => s.setAuth);

  const scan = async (qrPayload: string): Promise<ScanResponse> => {
    const res = await api.post<ScanResponse>("/attendance/scan/", {
      qr_payload: qrPayload,
    });
    const data = res.data;

    if (data.action === "check_in" && data.token && data.username && data.role) {
      setAuth(data.token, data.username, data.role);
    }
    return data;
  };

  return { scan };
}
