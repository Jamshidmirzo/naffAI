import { Toaster, toast } from "sonner";
import { useTheme } from "../../store/theme";

export function ToastHost() {
  const theme = useTheme((s) => s.theme);
  return (
    <Toaster
      position="bottom-center"
      duration={2400}
      theme={theme}
      offset={26}
      toastOptions={{
        style: {
          background: "var(--text)",
          color: "var(--bg)",
          border: 0,
          borderRadius: 99,
          padding: "13px 24px",
          fontSize: 13.5,
          fontWeight: 500,
        },
      }}
    />
  );
}

export { toast };
