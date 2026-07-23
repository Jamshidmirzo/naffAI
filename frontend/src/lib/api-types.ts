export interface ApiError {
  response?: {
    status?: number;
    data?: {
      detail?: string;
      [k: string]: unknown;
    };
  };
  message?: string;
}

export function apiErrorMessage(err: unknown): string {
  const e = err as ApiError;
  return (
    e?.response?.data?.detail ||
    (typeof e?.response?.data === "object" &&
      e?.response?.data !== null &&
      Object.values(e.response.data)[0]?.toString()) ||
    e?.message ||
    "Ошибка"
  );
}
