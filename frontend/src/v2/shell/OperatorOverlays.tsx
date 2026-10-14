import MorningGreeting from "../../components/MorningGreeting";
import { HelperButton } from "../../components/helper/HelperButton";
import CheckinGate from "../../components/CheckinGate";
import CheckoutBackfillGate from "../../components/CheckoutBackfillGate";
import BirthdayCelebration from "../../components/BirthdayCelebration";
import SaleCelebration from "../../components/SaleCelebration";
import SnapshotRequestPrompt from "../../components/SnapshotRequestPrompt";
import LiveStreamPublisher from "../../components/LiveStreamPublisher";

/**
 * Operator-only overlays, mounted exactly like in the old AppShell
 * (attendance gates, celebrations, snapshot consent, live publisher).
 * They are business-critical, so the v2 shell reuses the same components;
 * their look is restyled through the v2 CSS scope where possible.
 */
export function OperatorOverlays({ livestream, language }: { livestream: boolean; language: "ru" | "uz" }) {
  return (
    <>
      <BirthdayCelebration />
      <SaleCelebration />
      <SnapshotRequestPrompt />
      <MorningGreeting language={language} />
      <CheckinGate />
      <CheckoutBackfillGate />
      <HelperButton />
      <LiveStreamPublisher enabled={livestream} />
    </>
  );
}
