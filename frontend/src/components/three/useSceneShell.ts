import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useTheme } from "../../store/theme";

export interface SceneCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  group: THREE.Group;
  theme: "light" | "dark";
}

export interface SceneUpdate {
  (ctx: SceneCtx, elapsed: number): void;
}

interface Options {
  build: (ctx: SceneCtx) => void;
  update?: SceneUpdate;
  rebuildDeps?: unknown[];
}

const LIGHT = {
  ambientTop: 0xffffff,
  ambientBottom: 0xffd9be,
  hemiIntensity: 1.1,
  dirIntensity: 2.2,
};

const DARK = {
  ambientTop: 0xffffff,
  ambientBottom: 0xffd9be,
  hemiIntensity: 0.7,
  dirIntensity: 1.6,
};

/**
 * Shared three.js scaffold: renderer, camera, lights, parallax, autospin,
 * ResizeObserver, RAF, and cleanup. Wraps a caller-supplied `build` (which
 * populates `group`) and optional `update` (called each frame).
 */
export function useThreeScene<T extends HTMLElement>(
  { build, update, rebuildDeps = [] }: Options,
) {
  const ref = useRef<T | null>(null);
  const theme = useTheme((s) => s.theme);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 1.6, 6);
    camera.lookAt(0, 0.5, 0);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    // Lights — per handoff.
    const p = theme === "dark" ? DARK : LIGHT;
    const hemi = new THREE.HemisphereLight(p.ambientTop, p.ambientBottom, p.hemiIntensity);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, p.dirIntensity);
    dir.position.set(3, 4, 5);
    scene.add(dir);
    const point = new THREE.PointLight(0xff7a1a, 26, 12);
    point.position.set(-3.5, -1.5, 3);
    scene.add(point);

    const group = new THREE.Group();
    scene.add(group);

    const ctx: SceneCtx = { scene, camera, renderer, group, theme };
    build(ctx);

    // Parallax / mouse tracking
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      mouse.tx = ((e.clientX - rect.left) / rect.width - 0.5) * 1.1; // ~±0.55
      mouse.ty = ((e.clientY - rect.top) / rect.height - 0.5) * -1.1;
    };
    window.addEventListener("mousemove", onMouseMove, { passive: true });

    // Resize
    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    // RAF loop
    const start = performance.now();
    let raf = 0;
    const loop = () => {
      const t = (performance.now() - start) / 1000;
      mouse.x += (mouse.tx - mouse.x) * 0.05;
      mouse.y += (mouse.ty - mouse.y) * 0.05;
      group.rotation.y = mouse.x + Math.sin(t * 0.17) * 0.17;
      group.rotation.x = mouse.y * 0.4;
      if (update) update(ctx, t);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // Cleanup
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMouseMove);
      ro.disconnect();
      renderer.dispose();
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
        const mat = (obj as THREE.Mesh).material;
        if (mat) {
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      });
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, ...rebuildDeps]);

  return ref;
}
