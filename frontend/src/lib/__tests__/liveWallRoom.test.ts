import { describe, expect, it, vi } from "vitest";
import { computeSubscriptions, type SubscribablePublication } from "../liveWallRoom";

function pub(
  kind: string,
  source: string,
  isDesired: boolean,
): SubscribablePublication & { setSubscribed: ReturnType<typeof vi.fn> } {
  return { kind, source, isDesired, isSubscribed: isDesired, setSubscribed: vi.fn() };
}

function participant(identity: string, pubs: SubscribablePublication[]) {
  return { identity, trackPublications: new Map(pubs.map((p, i) => [`TR_${identity}_${i}`, p])) };
}

describe("computeSubscriptions", () => {
  it("subscribes wanted cameras and unsubscribes the rest — changes only", () => {
    const aCam = pub("video", "camera", false);
    const bCam = pub("video", "camera", true);
    const cCam = pub("video", "camera", true);
    const dCam = pub("video", "camera", false);
    const changes = computeSubscriptions(
      [participant("op:1", [aCam]), participant("op:2", [bCam]), participant("op:3", [cCam]), participant("op:4", [dCam])],
      new Set(["op:1", "op:3"]),
    );
    expect(changes).toEqual([
      { identity: "op:1", publication: aCam, subscribe: true },
      { identity: "op:2", publication: bCam, subscribe: false },
    ]);
  });

  it("ignores audio, screen-share and non-video publications", () => {
    const audio = pub("audio", "microphone", false);
    const screen = pub("video", "screen_share", false);
    const cam = pub("video", "camera", false);
    const changes = computeSubscriptions([participant("op:1", [audio, screen, cam])], new Set(["op:1"]));
    expect(changes.map((c) => c.publication)).toEqual([cam]);
  });

  it("treats source 'unknown' video as a camera (older publishers)", () => {
    const v = pub("video", "unknown", false);
    expect(computeSubscriptions([participant("op:9", [v])], new Set(["op:9"]))).toHaveLength(1);
  });

  it("falls back to isSubscribed when isDesired is absent", () => {
    const p: SubscribablePublication = { kind: "video", source: "camera", isSubscribed: true, setSubscribed: vi.fn() };
    expect(computeSubscriptions([participant("op:1", [p])], new Set(["op:1"]))).toEqual([]);
    expect(computeSubscriptions([participant("op:1", [p])], new Set())).toHaveLength(1);
  });

  it("empty wanted set unsubscribes everyone; nothing to do for no participants", () => {
    const a = pub("video", "camera", true);
    expect(computeSubscriptions([participant("op:1", [a])], new Set())).toEqual([
      { identity: "op:1", publication: a, subscribe: false },
    ]);
    expect(computeSubscriptions([], new Set(["op:1"]))).toEqual([]);
  });

  it("accepts any iterable of participants (Map.values())", () => {
    const a = pub("video", "camera", false);
    const m = new Map([["op:1", participant("op:1", [a])]]);
    expect(computeSubscriptions(m.values(), new Set(["op:1"]))).toHaveLength(1);
  });
});
