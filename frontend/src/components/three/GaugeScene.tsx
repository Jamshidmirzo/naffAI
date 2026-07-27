import * as THREE from "three";
import { useThreeScene } from "./useSceneShell";

interface Props {
  percent: number;
  className?: string;
  style?: React.CSSProperties;
}

const ACCENT = 0xf2560b;

/**
 * Ring gauge for the operator dashboard — grey base torus + accent arc
 * showing progress, with 3 satellite spheres orbiting (metaphor for
 * leads-in-flight).
 */
export function GaugeScene({ percent, className, style }: Props) {
  const clamped = Math.max(0, Math.min(1, percent / 100));

  const ref = useThreeScene<HTMLDivElement>({
    rebuildDeps: [clamped.toFixed(3)],
    build: (ctx) => {
      const { group, theme } = ctx;

      const base = new THREE.Mesh(
        new THREE.TorusGeometry(1.5, 0.13, 32, 96),
        new THREE.MeshPhysicalMaterial({
          color: theme === "dark" ? 0x2a2a30 : 0xf0f0f4,
          roughness: 0.5,
          metalness: 0.05,
          clearcoat: 0.8,
        }),
      );
      base.rotation.x = 0.15;
      group.add(base);

      const arc = new THREE.Mesh(
        new THREE.TorusGeometry(
          1.5,
          0.14,
          32,
          Math.max(6, Math.floor(96 * clamped)),
          Math.PI * 2 * clamped,
        ),
        new THREE.MeshPhysicalMaterial({
          color: ACCENT,
          roughness: 0.25,
          metalness: 0.35,
          clearcoat: 1,
          emissive: 0x2a1108,
          emissiveIntensity: 0.4,
        }),
      );
      arc.rotation.x = 0.15;
      arc.rotation.z = Math.PI / 2;
      arc.userData.isArc = true;
      group.add(arc);

      // 3 orbiting satellites
      const satellites: THREE.Mesh[] = [];
      for (let i = 0; i < 3; i++) {
        const isAccent = i === 0;
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 24, 24),
          isAccent
            ? new THREE.MeshPhysicalMaterial({
                color: ACCENT,
                roughness: 0.2,
                clearcoat: 1,
              })
            : new THREE.MeshPhysicalMaterial({
                color: 0xffffff,
                transmission: 0.9,
                roughness: 0.05,
                clearcoat: 1,
                transparent: true,
                opacity: 0.9,
                ior: 1.4,
              }),
        );
        sphere.userData.phase = (i / 3) * Math.PI * 2;
        sphere.userData.radius = 2.05 + i * 0.05;
        satellites.push(sphere);
        group.add(sphere);
      }
      group.userData.satellites = satellites;
    },
    update: (ctx, t) => {
      const satellites = ctx.group.userData.satellites as THREE.Mesh[] | undefined;
      if (satellites) {
        satellites.forEach((s) => {
          const phase = (s.userData.phase as number) + t * 0.55;
          const r = s.userData.radius as number;
          s.position.x = Math.cos(phase) * r;
          s.position.y = Math.sin(phase * 0.7) * 0.35;
          s.position.z = Math.sin(phase) * r * 0.4;
        });
      }
    },
  });

  return <div ref={ref} className={className} style={style} />;
}
