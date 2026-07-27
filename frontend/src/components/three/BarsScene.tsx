import * as THREE from "three";
import { useThreeScene } from "./useSceneShell";

interface Props {
  values: number[];
  className?: string;
  style?: React.CSSProperties;
}

const ACCENT = 0xf2560b;
const WARM_LIGHT = 0xffd9bd;
const WARM_DARK = 0x3a2921;

function mix(a: THREE.Color, b: THREE.Color, t: number) {
  return new THREE.Color(
    a.r * (1 - t) + b.r * t,
    a.g * (1 - t) + b.g * t,
    a.b * (1 - t) + b.b * t,
  );
}

/**
 * Bar chart in three-D. `values` are non-negative; the tallest one is
 * pure accent, the rest are blended toward warm-neutral so the peak
 * always reads first.
 */
export function BarsScene({ values, className, style }: Props) {
  const ref = useThreeScene<HTMLDivElement>({
    rebuildDeps: [values.join(",")],
    build: (ctx) => {
      const { group, theme } = ctx;
      if (!values.length) return;

      const max = Math.max(...values, 1);
      const count = values.length;
      const size = count > 8 ? 0.26 : 0.38;
      const step = 0.62;
      const totalW = (count - 1) * step;
      const warmColor = new THREE.Color(theme === "dark" ? WARM_DARK : WARM_LIGHT);
      const accentColor = new THREE.Color(ACCENT);

      // Floor
      const floorGeo = new THREE.CircleGeometry(4.4, 64);
      const floorMat = new THREE.MeshBasicMaterial({
        color: ACCENT,
        transparent: true,
        opacity: theme === "dark" ? 0.08 : 0.05,
      });
      const floor = new THREE.Mesh(floorGeo, floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.02;
      group.add(floor);

      // Bars
      const peakIdx = values.reduce((acc, v, i) => (v > values[acc] ? i : acc), 0);
      values.forEach((v, i) => {
        const height = 0.45 + (v / max) * 2.85;
        const geo = new THREE.BoxGeometry(size, height, size);
        geo.translate(0, height / 2, 0);
        const color = i === peakIdx ? accentColor : mix(warmColor, accentColor, 0.55);
        const mat = new THREE.MeshPhysicalMaterial({
          color,
          metalness: 0.15,
          roughness: 0.35,
          clearcoat: 1,
          clearcoatRoughness: 0.25,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.x = -totalW / 2 + i * step;
        mesh.scale.y = 0.001;
        mesh.userData.growTarget = 1;
        mesh.userData.growDelay = i * 0.07;
        group.add(mesh);

        if (i === peakIdx) {
          const sphereGeo = new THREE.SphereGeometry(0.28, 32, 32);
          const sphereMat = new THREE.MeshPhysicalMaterial({
            color: accentColor,
            transmission: 0.9,
            roughness: 0.05,
            metalness: 0,
            clearcoat: 1,
            transparent: true,
            opacity: 0.85,
            ior: 1.4,
          });
          const sphere = new THREE.Mesh(sphereGeo, sphereMat);
          sphere.position.set(mesh.position.x, height + 0.55, 0);
          sphere.userData.isPeakSphere = true;
          sphere.userData.baseY = height + 0.55;
          group.add(sphere);
        }
      });
    },
    update: (ctx, t) => {
      ctx.group.traverse((obj) => {
        if ((obj as THREE.Mesh).userData?.growTarget != null) {
          const mesh = obj as THREE.Mesh;
          const delay = mesh.userData.growDelay ?? 0;
          const local = Math.max(0, Math.min(1, (t - delay) / 0.6));
          const eased = 1 - Math.pow(1 - local, 3);
          const breath = local >= 1 ? 1 + Math.sin(t * 1.8 + delay * 5) * 0.02 : 1;
          mesh.scale.y = eased * breath;
        }
        if ((obj as THREE.Mesh).userData?.isPeakSphere) {
          const mesh = obj as THREE.Mesh;
          const baseY = mesh.userData.baseY ?? 0;
          mesh.position.y = baseY + Math.sin(t * 1.4) * 0.08;
        }
      });
    },
  });

  return <div ref={ref} className={className} style={style} />;
}
