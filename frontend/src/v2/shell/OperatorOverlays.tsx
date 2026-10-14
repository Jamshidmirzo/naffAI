import MorningGreetingV2 from "../overlays/MorningGreetingV2";
import HelperButtonV2 from "../overlays/HelperButtonV2";
import CheckinGateV2 from "../overlays/CheckinGateV2";
import CheckoutBackfillGateV2 from "../overlays/CheckoutBackfillGateV2";
import SaleCelebrationV2 from "../overlays/SaleCelebrationV2";
import SnapshotRequestPromptV2 from "../overlays/SnapshotRequestPromptV2";
import LiveStreamPublisher from "../../components/LiveStreamPublisher";

/**
 * Operator-only overlays, mounted exactly like in the old AppShell
 * (attendance gates, celebrations, snapshot consent, live publisher), in the
 * Атлас look. Same logic/API as the old components, which stay in use by the
 * old AppShell. The birthday strip and the checkout reminder live in the
 * main column (V2Shell); LiveStreamPublisher is reused as is.
 */
export function OperatorOverlays({ livestream, language }: { livestream: boolean; language: "ru" | "uz" }) {
  return (
    <>
      <SaleCelebrationV2 />
      <SnapshotRequestPromptV2 />
      <MorningGreetingV2 language={language} />
      <CheckinGateV2 />
      <CheckoutBackfillGateV2 />
      <HelperButtonV2 />
      <LiveStreamPublisher enabled={livestream} />
    </>
  );
}
