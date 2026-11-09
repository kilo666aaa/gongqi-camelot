import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';

function createKnight() {
  const knight = new THREE.Group();
  const helmet = new THREE.Group();
  helmet.position.y = .38;
  knight.add(helmet);
  const steel = new THREE.MeshStandardMaterial({ color: '#b8accb', metalness: .38, roughness: .3 });
  const gold = new THREE.MeshStandardMaterial({ color: '#efb771', metalness: .4, roughness: .35 });
  const purple = new THREE.MeshStandardMaterial({ color: '#7943a4', roughness: .48 });
  const dark = new THREE.MeshStandardMaterial({ color: '#241635' });
  const light = new THREE.MeshBasicMaterial({ color: '#ffe4a5' });
  const sphere = new THREE.SphereGeometry(1, 20, 14);
  const cube = new THREE.BoxGeometry(1, 1, 1);
  function piece(material: THREE.Material, at: [number, number, number], size: [number, number, number],
    geometry: THREE.BufferGeometry = sphere, parent = knight) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...at);
    mesh.scale.set(...size);
    parent.add(mesh);
    return mesh;
  }
  piece(purple, [0, -.35, -.13], [.46, .67, .29]);
  piece(steel, [0, -.18, .04], [.42, .45, .34]);
  piece(gold, [0, -.19, .37], [.19, .21, .05], cube).rotation.z = Math.PI / 4;
  piece(steel, [0, .10, 0], [.55, .5, .48], sphere, helmet);
  piece(gold, [0, .03, .37], [.43, .24, .15], sphere, helmet);
  piece(dark, [0, .05, .46], [.39, .17, .095], sphere, helmet);
  piece(light, [-.13, .07, .55], [.064, .034, .024], sphere, helmet);
  piece(light, [.13, .07, .55], [.064, .034, .024], sphere, helmet);
  piece(purple, [.1, .60, -.13], [.17, .28, .3], sphere, helmet).rotation.z = -.4;
  piece(steel, [-.47, -.06, .17], [.22, .2, .22]);
  piece(steel, [.47, -.06, .17], [.22, .2, .22]);
  piece(gold, [-.34, -.32, .46], [.17, .13, .15]);
  piece(gold, [.34, -.32, .46], [.17, .13, .15]);
  piece(steel, [-.21, -.73, .09], [.2, .15, .26]);
  piece(steel, [.21, -.73, .09], [.2, .15, .26]);
  return { knight, helmet, release: () => {
    sphere.dispose();
    cube.dispose();
    [steel, gold, purple, dark, light].forEach(material => material.dispose());
  } };
}

export default function KnightModel({ open, fallback }: { open: boolean; fallback: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderPose = useRef<((open: boolean) => void) | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: element, alpha: true, antialias: true });
    } catch {
      setUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(112, 122, false);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1.1, -1.1, .1, 20);
    camera.position.set(0, .08, 5);
    camera.lookAt(0, .08, 0);
    const key = new THREE.DirectionalLight('#ffe5c8', 3);
    key.position.set(-2, 3, 4);
    const { knight, helmet, release } = createKnight();
    scene.add(knight, key, new THREE.HemisphereLight('#e5caff', '#4b2669', 2));
    const trigger = element.closest('button');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let swayStarted = -Infinity;
    let targetYaw = 0;
    let targetPitch = 0;
    let lastFrame = 0;
    function queueFrame() {
      if (!frame) frame = requestAnimationFrame(animate);
    }
    function animate(time: number) {
      frame = 0;
      const elapsed = time - swayStarted;
      const sway = Math.max(0, 1 - elapsed / 480);
      const blend = 1 - Math.exp(-Math.min(time - lastFrame, 40) / 65);
      lastFrame = time;
      helmet.rotation.y = THREE.MathUtils.lerp(helmet.rotation.y, targetYaw, blend);
      helmet.rotation.x = THREE.MathUtils.lerp(helmet.rotation.x, targetPitch, blend);
      const settling = Math.abs(helmet.rotation.y - targetYaw) + Math.abs(helmet.rotation.x - targetPitch) > .002;
      if (!settling) helmet.rotation.set(targetPitch, targetYaw, 0);
      knight.rotation.z = Math.sin(elapsed / 480 * Math.PI * 3) * sway * .17 || 0;
      renderer.render(scene, camera);
      if (sway > 0 || settling) queueFrame();
    }
    function followPointer(event: PointerEvent) {
      if (!trigger || event.pointerType !== 'mouse' || reducedMotion.matches) return;
      const rect = trigger.getBoundingClientRect();
      targetYaw = THREE.MathUtils.clamp((event.clientX - rect.left) / rect.width - .5, -.5, .5) * .9;
      targetPitch = THREE.MathUtils.clamp((event.clientY - rect.top) / rect.height - .5, -.5, .5) * .55;
      queueFrame();
    }
    function greet(event: PointerEvent) {
      if (event.pointerType !== 'mouse' || reducedMotion.matches) return;
      swayStarted = performance.now();
      followPointer(event);
    }
    function resetGaze() {
      targetYaw = 0;
      targetPitch = 0;
      if (reducedMotion.matches) {
        cancelAnimationFrame(frame);
        frame = 0;
        swayStarted = -Infinity;
        knight.rotation.z = 0;
        helmet.rotation.set(0, 0, 0);
        renderer.render(scene, camera);
      } else {
        queueFrame();
      }
    }
    trigger?.addEventListener('pointerenter', greet);
    trigger?.addEventListener('pointermove', followPointer);
    trigger?.addEventListener('pointerleave', resetGaze);
    reducedMotion.addEventListener('change', resetGaze);
    renderPose.current = nextOpen => {
      knight.rotation.y = nextOpen ? -.22 : -.48;
      renderer.render(scene, camera);
    };
    const lost = () => setUnavailable(true);
    element.addEventListener('webglcontextlost', lost);
    return () => {
      cancelAnimationFrame(frame);
      trigger?.removeEventListener('pointerenter', greet);
      trigger?.removeEventListener('pointermove', followPointer);
      trigger?.removeEventListener('pointerleave', resetGaze);
      reducedMotion.removeEventListener('change', resetGaze);
      element.removeEventListener('webglcontextlost', lost);
      renderPose.current = null;
      release();
      renderer.dispose();
    };
  }, [unavailable]);

  useEffect(() => { renderPose.current?.(open); }, [open, unavailable]);

  return unavailable ? fallback : <canvas ref={canvas} width="112" height="122" aria-hidden="true" />;
}
