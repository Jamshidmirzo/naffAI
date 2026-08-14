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
  photo_url?: string;
}

/**
 * Attendance-scan hook — accepts an optional photo File. When a photo is
 * present the request is sent as multipart/form-data, otherwise as JSON.
 * The backend `/attendance/scan/` endpoint accepts both.
 */
export function useAttendanceScan() {
  const setAuth = useAuth((s) => s.setAuth);

  const scan = async (qrPayload: string, photo?: File): Promise<ScanResponse> => {
    let res;
    if (photo) {
      const fd = new FormData();
      fd.append("qr_payload", qrPayload);
      fd.append("photo", photo);
      res = await api.post<ScanResponse>("/attendance/scan/", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    } else {
      res = await api.post<ScanResponse>("/attendance/scan/", {
        qr_payload: qrPayload,
      });
    }
    const data = res.data;
    if (data.action === "check_in" && data.token && data.username && data.role) {
      setAuth(data.token, data.username, data.role);
    }
    return data;
  };

  return { scan };
}
