/**
 * LiveVideo — renders one LiveKit video track into a muted <video>.
 * Attach/detach is keyed on the track object, so re-renders never
 * re-attach and unmount always detaches (lets adaptiveStream see the
 * element disappear and pause the layer).
 */

import { useEffect, useRef, type CSSProperties } from "react";
import type { RemoteVideoTrack } from "livekit-client";

interface Props {
  track: RemoteVideoTrack | null | undefined;
  className?: string;
  style?: CSSProperties;
  objectFit?: CSSProperties["objectFit"];
}

export default function LiveVideo({ track, className, style, objectFit = "cover" }: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return (
    <video
      ref={ref}
      autoPlay
      muted
      playsInline
      className={className}
      style={{ objectFit, ...style }}
    />
  );
}
