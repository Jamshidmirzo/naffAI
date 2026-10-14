import AppShell from "../../components/layout/AppShell";
import { useDesign } from "../../store/design";
import { V2Shell } from "./V2Shell";

/** Layout route element: old shell or the new «Атлас» shell. */
export function ShellSwitch() {
  const design = useDesign((s) => s.design);
  return design === "v2" ? <V2Shell /> : <AppShell />;
}
