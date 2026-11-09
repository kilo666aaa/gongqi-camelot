import * as THREE from 'three';

export const COAT_PALETTE = [
  '#8f3d3d',
  '#3f6b8f',
  '#5c7a4a',
  '#8a6a3a',
  '#6a4a7a',
  '#3f7a72',
];

export interface RoundTableOptions {
  memberCount: number;
  myIndex: number;
  reducedMotion: boolean;
  /** 席位悬停 / 选中变化。只回传席位的公开序号，不携带任何私密内容。 */
  onSeatChange?: (index: number | null) => void;
}

export interface RoundTableHandle {
  burst(): void;
  updateMembers(memberCount: number, myIndex: number): void;
  dispose(): void;
}

const PARTICLE_COUNT = 96;
const BURST_DURATION = 2.1;

function buildFigure(color: string, isElder: boolean, isMe: boolean) {
  const group = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color, roughness: 0.86, metalness: 0.06 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x080c0b, roughness: 1 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xd6a487, roughness: 0.78 });

  if (!isElder) {
    const oak = new THREE.MeshStandardMaterial({ color: 0x4c2826, roughness: 0.64 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xc69958, roughness: 0.4, metalness: 0.4 });
    const velvet = new THREE.MeshStandardMaterial({ color: 0x562a57, roughness: 0.9 });
    const back = new THREE.Mesh(new THREE.BoxGeometry(.84, 1.47, .12), oak);
    back.position.set(0, .88, -.36);
    const crest = new THREE.Mesh(new THREE.BoxGeometry(.93, .12, .2), brass);
    crest.position.set(0, 1.63, -.35);
    const cushion = new THREE.Mesh(new THREE.BoxGeometry(.72, .13, .65), velvet);
    cushion.position.set(0, .41, -.02);
    const pauldrons = new THREE.Mesh(new THREE.SphereGeometry(.37, 16, 10), brass);
    pauldrons.position.y = 1.07;
    pauldrons.scale.set(1.15, .44, .74);
    group.add(back, crest, cushion, pauldrons);
  }

  const cloak = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.4, 18, 1, true), cloth);
  cloak.position.y = 0.7;
  group.add(cloak);

  const shoulders = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    cloth,
  );
  shoulders.position.y = 1.2;
  shoulders.scale.set(1.12, 0.72, 0.92);
  group.add(shoulders);

  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.27, 20, 16), cloth);
  hood.position.y = 1.49;
  hood.scale.set(1, 1.1, 1.06);
  group.add(hood);

  const shadow = new THREE.Mesh(new THREE.SphereGeometry(0.205, 16, 12), dark);
  shadow.position.set(0, 1.48, 0.08);
  group.add(shadow);

  const face = new THREE.Mesh(new THREE.SphereGeometry(0.15, 18, 14), skin);
  face.position.set(0, 1.46, 0.13);
  face.scale.set(1, 1.08, 0.72);
  group.add(face);

  const mask = new THREE.Mesh(
    new THREE.SphereGeometry(0.158, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.54),
    dark,
  );
  mask.position.copy(face.position);
  mask.scale.set(1.03, 1, 0.8);
  group.add(mask);

  if (isElder) {
    const trim = new THREE.Mesh(
      new THREE.TorusGeometry(0.33, 0.02, 8, 32),
      new THREE.MeshStandardMaterial({ color: 0xd8b46a, roughness: 0.35, metalness: 0.8 }),
    );
    trim.rotation.x = Math.PI / 2;
    trim.position.y = 1.05;
    group.add(trim);

    const staff = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.026, 1.5, 8),
      new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.7 }),
    );
    staff.position.set(0.4, 0.85, 0.06);
    group.add(staff);
  }

  if (isMe) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.47, 48),
      new THREE.MeshBasicMaterial({
        color: 0x8ff0c8, transparent: true, opacity: 0.42,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    group.add(ring);
  }

  return group;
}

export function createRoundTableScene(
  container: HTMLElement,
  options: RoundTableOptions,
): RoundTableHandle {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    container.dataset.failed = '1';
    return { burst: () => undefined, updateMembers: () => undefined, dispose: () => undefined };
  }

  const reducedMotion = options.reducedMotion;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.24;
  container.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  // 垂直滑动仍交给页面滚动，水平拖拽才用于转动圆桌。
  canvas.style.touchAction = 'pan-y';

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x231229, 0.036);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);
  camera.position.set(0, 3.55, 7.5);
  const lookAt = new THREE.Vector3(0, 0.85, 0);
  camera.lookAt(lookAt);

  // 视角与席位选择：纯视觉增强，不读写任何业务数据。
  // 视角限制在圆桌始终可辨认的范围，避免拖到只剩长老背影的极端角度。
  const MAX_AZIMUTH = 1.15;
  const MIN_ELEVATION = -0.6;
  const MAX_ELEVATION = 1.2;
  let azimuth = 0;
  let targetAzimuth = 0;
  let elevation = 0;
  let targetElevation = 0;
  let hovered = -1;
  let selected = -1;
  let reported: number | null = null;
  let dragging = false;
  const updateCursor = () => {
    canvas.style.cursor = dragging ? 'grabbing' : hovered >= 0 ? 'pointer' : 'grab';
  };
  updateCursor();

  scene.add(new THREE.HemisphereLight(0xc59af4, 0x432b3b, 1.55));
  const keyLight = new THREE.PointLight(0xffb26b, 26, 18, 2);
  keyLight.position.set(0.4, 3.2, 1.2);
  scene.add(keyLight);
  const rimLight = new THREE.PointLight(0xad62ff, 24, 16, 2);
  rimLight.position.set(-3.4, 2.6, -3.2);
  scene.add(rimLight);

  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(value: T) => {
    disposables.push(value);
    return value;
  };

  const floor = new THREE.Mesh(
    track(new THREE.CircleGeometry(3.35, 64)),
    track(new THREE.MeshStandardMaterial({ color: 0x392a42, roughness: .82 })),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const plinth = new THREE.Mesh(
    track(new THREE.CylinderGeometry(3.36, 3.55, .18, 64)),
    track(new THREE.MeshStandardMaterial({ color: 0x4f3448, roughness: .75 })),
  );
  plinth.position.y = -.1;
  scene.add(plinth);

  const table = new THREE.Group();
  table.position.y = 0.72;
  scene.add(table);

  const tableTop = new THREE.Mesh(
    track(new THREE.CylinderGeometry(2.05, 2.05, 0.1, 64)),
    track(new THREE.MeshStandardMaterial({ color: 0x75412b, roughness: 0.62, metalness: 0.04 })),
  );
  table.add(tableTop);

  const tableEdge = new THREE.Mesh(
    track(new THREE.TorusGeometry(2.05, 0.05, 10, 64)),
    track(new THREE.MeshStandardMaterial({ color: 0x7a5a34, roughness: 0.42, metalness: 0.7 })),
  );
  tableEdge.rotation.x = Math.PI / 2;
  tableEdge.position.y = 0.02;
  table.add(tableEdge);

  const pedestal = new THREE.Mesh(
    track(new THREE.CylinderGeometry(0.42, 0.62, 0.72, 24)),
    track(new THREE.MeshStandardMaterial({ color: 0x4e2e36, roughness: 0.9 })),
  );
  pedestal.position.y = -0.38;
  table.add(pedestal);

  const sigilMaterial = track(new THREE.MeshBasicMaterial({
    color: 0xd58bff, transparent: true, opacity: 0.32,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  const sigil = new THREE.Mesh(track(new THREE.RingGeometry(0.62, 0.7, 72)), sigilMaterial);
  sigil.rotation.x = -Math.PI / 2;
  sigil.position.y = 0.07;
  table.add(sigil);

  const innerSigilMaterial = track(new THREE.MeshBasicMaterial({
    color: 0xffe1a8, transparent: true, opacity: 0.1,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  const innerSigil = new THREE.Mesh(track(new THREE.RingGeometry(0.3, 0.34, 64)), innerSigilMaterial);
  innerSigil.rotation.x = -Math.PI / 2;
  innerSigil.position.y = 0.07;
  table.add(innerSigil);
  const inlay = track(new THREE.MeshStandardMaterial({ color: 0xc99a57, metalness: .45, roughness: .5 }));
  for (const radius of [1.38, 1.83]) {
    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(radius, .014, 6, 64)), inlay);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = .065;
    table.add(ring);
  }

  const candleMaterial = track(new THREE.MeshStandardMaterial({ color: 0xe6d8bd, roughness: 0.85 }));
  const flameMaterial = track(new THREE.MeshBasicMaterial({ color: 0xffc07a }));
  const flames: THREE.Mesh[] = [];
  for (let index = 0; index < 6; index += 1) {
    const angle = (index / 6) * Math.PI * 2 + 0.3;
    const candle = new THREE.Mesh(track(new THREE.CylinderGeometry(0.035, 0.04, 0.2, 8)), candleMaterial);
    candle.position.set(Math.cos(angle) * 1.62, 0.15, Math.sin(angle) * 1.62);
    table.add(candle);
    const flame = new THREE.Mesh(track(new THREE.SphereGeometry(0.032, 8, 8)), flameMaterial);
    flame.position.set(candle.position.x, 0.28, candle.position.z);
    table.add(flame);
    flames.push(flame);
  }

  const figures: THREE.Group[] = [];
  const figureAngles: number[] = [];
  const focusRings: THREE.Mesh[] = [];
  const disposeFigure = (figure: THREE.Group) => {
    scene.remove(figure);
    figure.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach(item => item.dispose());
      else material?.dispose();
    });
  };
  const applyHighlight = () => {
    const active = hovered >= 0 ? hovered : selected;
    focusRings.forEach((ring, index) => { ring.visible = index === active; });
    const next = active >= 0 ? active : null;
    if (next !== reported) {
      reported = next;
      options.onSeatChange?.(next);
    }
    updateCursor();
  };
  const rebuildFigures = (requested: number, myIndex: number) => {
    figures.splice(0).forEach(disposeFigure);
    focusRings.length = 0;
    figureAngles.length = 0;
    hovered = -1;
    selected = -1;
    const count = Math.min(Math.max(Math.round(requested), 1), 6);
    const spacing = count > 1 ? Math.min(0.9, 2.7 / (count - 1)) : 0;
    for (let index = 0; index < count; index += 1) {
      const angle = Math.PI + (index - (count - 1) / 2) * spacing;
      const figure = buildFigure(
        COAT_PALETTE[index % COAT_PALETTE.length] ?? '#5c7a4a',
        false,
        index === myIndex,
      );
      figure.position.set(Math.sin(angle) * 2.38, 0, Math.cos(angle) * 2.38);
      figure.rotation.y = angle + Math.PI;
      figure.scale.setScalar(0.96);
      // 选中 / 悬停时脚下亮起的环；默认隐藏，只作视觉定位。
      const focusRing = new THREE.Mesh(
        new THREE.RingGeometry(0.54, 0.62, 48),
        new THREE.MeshBasicMaterial({
          color: 0xffd08a, transparent: true, opacity: 0.72,
          side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      focusRing.rotation.x = -Math.PI / 2;
      focusRing.position.y = 0.03;
      focusRing.visible = false;
      figure.add(focusRing);
      focusRings.push(focusRing);
      figureAngles.push(angle);
      scene.add(figure);
      figures.push(figure);
    }
    applyHighlight();
  };
  rebuildFigures(options.memberCount, options.myIndex);

  const elder = buildFigure('#2c3054', true, false);
  elder.position.set(-2.65, 0, -1.85);
  elder.scale.setScalar(1);
  elder.rotation.y = Math.atan2(2.75, 2.2);
  scene.add(elder);

  const elderOrbMaterial = track(new THREE.MeshBasicMaterial({ color: 0xe5b7ff }));
  const elderOrb = new THREE.Mesh(track(new THREE.SphereGeometry(0.085, 16, 16)), elderOrbMaterial);
  elderOrb.position.set(0.4, 1.62, 0.06);
  elder.add(elderOrb);

  const elderGlow = new THREE.PointLight(0xbc6bff, 6, 5, 2);
  elderGlow.position.set(-2.65, 1.62, -1.85);
  scene.add(elderGlow);

  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const motesState = Array.from({ length: PARTICLE_COUNT }, () => ({
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
  }));
  const particleGeometry = track(new THREE.BufferGeometry());
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  particleGeometry.setAttribute('position', positionAttribute);
  const particleMaterial = track(new THREE.PointsMaterial({
    color: 0xffe1a8, size: 0.05, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
  const motes = new THREE.Points(particleGeometry, particleMaterial);
  motes.position.y = 0.86;
  scene.add(motes);

  let burstAge = BURST_DURATION;
  const burst = () => {
    burstAge = 0;
    motesState.forEach((mote, index) => {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 0.75;
      mote.x = Math.cos(angle) * radius;
      mote.y = Math.random() * 0.08;
      mote.z = Math.sin(angle) * radius;
      mote.vx = Math.cos(angle) * (0.2 + Math.random() * 0.45);
      mote.vy = 0.55 + Math.random() * 0.95;
      mote.vz = Math.sin(angle) * (0.2 + Math.random() * 0.45);
      positions[index * 3] = mote.x;
      positions[index * 3 + 1] = mote.y;
      positions[index * 3 + 2] = mote.z;
    });
    positionAttribute.needsUpdate = true;
  };

  let elapsed = 0;
  let previous = performance.now();
  let frame = 0;

  const render = (now: number) => {
    const delta = Math.min((now - previous) / 1000, 0.05);
    previous = now;
    elapsed += delta;

    // 手动拖拽优先：自动漂浮只剩极小幅度，reduced-motion 下完全关闭。
    const ease = reducedMotion ? 1 : Math.min(1, delta * 9);
    azimuth += (targetAzimuth - azimuth) * ease;
    elevation += (targetElevation - elevation) * ease;
    const drift = reducedMotion ? 0 : Math.sin(elapsed * 0.22) * 0.02;
    const bob = reducedMotion ? 0 : Math.sin(elapsed * 0.17) * 0.05;
    camera.position.set(
      Math.sin(azimuth + drift) * 7.5,
      3.55 + elevation + bob,
      Math.cos(azimuth + drift) * 7.5,
    );
    camera.lookAt(lookAt);

    if (!reducedMotion) {
      flames.forEach((flame, index) => {
        const flicker = 0.85 + Math.sin(elapsed * (5 + index * 0.7) + index) * 0.15;
        flame.scale.set(flicker, 0.9 + flicker * 0.3, flicker);
      });
      keyLight.intensity = 24 + Math.sin(elapsed * 1.7) * 2.2;
      elderGlow.intensity = 3.1 + Math.sin(elapsed * 1.3) * 0.7;
    }

    if (burstAge < BURST_DURATION) {
      burstAge += delta;
      const progress = burstAge / BURST_DURATION;
      motesState.forEach((mote, index) => {
        mote.vy -= 0.42 * delta;
        mote.x += mote.vx * delta;
        mote.y = Math.max(0, mote.y + mote.vy * delta);
        mote.z += mote.vz * delta;
        positions[index * 3] = mote.x;
        positions[index * 3 + 1] = mote.y;
        positions[index * 3 + 2] = mote.z;
      });
      positionAttribute.needsUpdate = true;
      particleMaterial.opacity = Math.max(0, 1 - progress) * 0.85;
    } else {
      particleMaterial.opacity = 0;
    }

    sigil.rotation.z += delta * 0.12;
    innerSigil.rotation.z -= delta * 0.18;
    sigilMaterial.opacity = 0.14 + Math.sin(elapsed * 1.2) * 0.04;
    elderOrb.scale.setScalar(1 + Math.sin(elapsed * 2.1) * 0.09);
    elder.position.y = 1.15 + Math.sin(elapsed * 0.9) * 0.05;

    renderer.render(scene, camera);
    frame = requestAnimationFrame(render);
  };

  const resize = () => {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else if (frame === 0) {
      previous = performance.now();
      frame = requestAnimationFrame(render);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // —— 指针交互 ——
  // 拖动转视角；悬停 / 点击席位；双击复位。席位只回传公开序号，
  // 不读取想法、评价、草稿或任何私密数据。
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pickSeat = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(figures, true);
    for (const hit of hits) {
      // 脚下的环只作标记，不参与拾取，避免误触。
      if ((hit.object as THREE.Mesh).geometry instanceof THREE.RingGeometry) continue;
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        const index = figures.indexOf(node as THREE.Group);
        if (index >= 0) return index;
        node = node.parent;
      }
    }
    return -1;
  };

  let pointerId = -1;
  let lastX = 0;
  let lastY = 0;
  let moved = false;
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    dragging = true;
    moved = false;
    pointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    updateCursor();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (dragging && event.pointerId === pointerId) {
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
      lastX = event.clientX;
      lastY = event.clientY;
      targetAzimuth = Math.max(-MAX_AZIMUTH, Math.min(MAX_AZIMUTH, targetAzimuth - dx * 0.006));
      targetElevation = Math.max(MIN_ELEVATION, Math.min(MAX_ELEVATION, targetElevation + dy * 0.003));
      if (hovered !== -1) {
        hovered = -1;
        applyHighlight();
      }
    } else if (!dragging && event.pointerType !== 'touch') {
      const hit = pickSeat(event.clientX, event.clientY);
      if (hit !== hovered) {
        hovered = hit;
        applyHighlight();
      }
    }
  };
  const finishPointer = (event: PointerEvent, cancelled: boolean) => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    pointerId = -1;
    if (!cancelled && !moved) {
      const hit = pickSeat(event.clientX, event.clientY);
      if (hit >= 0) {
        selected = selected === hit ? -1 : hit;
        // 让选中的席位转到画面正中，构图仍保持「人坐对面」。
        const angle = figureAngles[selected];
        if (selected >= 0 && angle !== undefined) {
          targetAzimuth = Math.max(-MAX_AZIMUTH, Math.min(MAX_AZIMUTH, angle - Math.PI));
        }
      } else {
        selected = -1;
      }
      applyHighlight();
    }
    updateCursor();
  };
  const onPointerUp = (event: PointerEvent) => finishPointer(event, false);
  const onPointerCancel = (event: PointerEvent) => finishPointer(event, true);
  const onPointerLeave = () => {
    if (!dragging && hovered !== -1) {
      hovered = -1;
      applyHighlight();
    }
  };
  const onDoubleClick = () => {
    hovered = -1;
    selected = -1;
    targetAzimuth = 0;
    targetElevation = 0;
    applyHighlight();
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('dblclick', onDoubleClick);

  frame = requestAnimationFrame(render);

  return {
    burst,
    updateMembers: (memberCount, myIndex) => rebuildFigures(memberCount, myIndex),
    dispose: () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('dblclick', onDoubleClick);
      scene.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach(item => item.dispose());
        else material?.dispose();
      });
      disposables.forEach(item => item.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
