// Hands-on AR: load any 3D model, give its parts joints, and work them with your hands over a live camera feed.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { buildDemoChair } from './demo-chair.js';

const $ = id => document.getElementById(id);
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const AXES = { x: V3(1, 0, 0), y: V3(0, 1, 0), z: V3(0, 0, 1) };
const UP = V3(0, 1, 0);

// ---------------------------------------------------------------- scene
const glCanvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.02, 60);
function placeCamera() {
  const h = +$('camH').value, d = +$('camD').value;
  camera.position.set(0, h, d);
  camera.lookAt(0, 0.3, -0.1);
}
$('camH').oninput = $('camD').oninput = placeCamera;
placeCamera();
glCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  $('camD').value = Math.min(6, Math.max(0.8, +$('camD').value * (1 + Math.sign(e.deltaY) * 0.08)));
  placeCamera();
}, { passive: false });

const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1.5, 3, 1.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 12 });
scene.add(hemi, sun);
// invisible floor that only catches shadows, so the object sits in the camera image
const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: 0.35 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const floorPlane = new THREE.Plane(UP.clone(), 0);

// The object: `world` carries floor position + heading; the model sits inside it.
const world = new THREE.Group();
scene.add(world);
const obj = { pos: new THREE.Vector2(), vel: new THREE.Vector2(), yaw: 0, yawVel: 0 };
const BOUND = { x: 1.6, zMin: -2, zMax: 0.8 };

// ---------------------------------------------------------------- parts & joints
/** part = { name, node, cfg, pivot, parentQ, axisQ, restPos, value, vel, radius, grabbed } */
let model = null, parts = [], selected = null, modelName = 'demo-chair', lastSource = null;
const partOf = new Map();          // node -> part
let helper = null;

const DEFAULT_CFG = { type: 'fixed', axis: 'y', pivot: 'center', min: -30, max: 30, friction: 1.5, spring: false, rolls: false };
const isRot = c => c.type === 'hinge' || c.type === 'spin';

// Guess a joint from the part's name and shape. Returns null for "fixed".
function guessJoint(name, size) {
  const n = name.toLowerCase();
  const thinAxis = size.x <= size.y && size.x <= size.z ? 'x' : size.y <= size.z ? 'y' : 'z';
  const longAxis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
  if (/wheel|caster|castor|tyre|tire|roller/.test(n)) return { type: 'spin', axis: thinAxis, pivot: 'center', friction: 0.8, rolls: true };
  if (/fan|rotor|propell|blade|gear|pulley|knob|dial|turbine|impeller/.test(n)) return { type: 'spin', axis: thinAxis, pivot: 'center', friction: 0.4 };
  if (/door/.test(n)) return { type: 'hinge', axis: 'y', pivot: size.x >= size.z ? '-x' : '-z', min: 0, max: 110, friction: 2 };
  if (/lid|hatch|flap|cover|visor/.test(n)) return { type: 'hinge', axis: size.x >= size.z ? 'x' : 'z', pivot: size.x >= size.z ? '-z' : '-x', min: -110, max: 0, friction: 2 };
  if (/drawer|tray/.test(n)) return { type: 'slider', axis: 'z', pivot: 'center', min: 0, max: Math.round(size.z * 80), friction: 3 };
  if (/piston|plunger|rod|slide|ram|telescop/.test(n)) return { type: 'slider', axis: longAxis, pivot: 'center', min: -Math.round(size[longAxis] * 40), max: Math.round(size[longAxis] * 40), friction: 3, spring: true };
  if (/back|recline|lever|handle|pedal|trigger/.test(n) && !/armrest/.test(n)) return { type: 'hinge', axis: 'x', pivot: '-y', min: -20, max: 6, friction: 1, spring: true };
  if (/seat|swivel|turntable|turret|head|platter|carousel/.test(n)) return { type: 'spin', axis: 'y', pivot: 'center', friction: 1.2 };
  return null;
}
// Joints can also come from the model itself: glTF "extras" (custom properties in Blender/CAD), e.g.
// { "joint": "hinge", "axis": "y", "pivot": "-x", "min": 0, "max": 90, "spring": true }
function cfgFromExtras(node) {
  const u = node.userData || {};
  if (!u.joint) return null;
  const c = { type: String(u.joint) };
  for (const k of ['axis', 'pivot', 'min', 'max', 'friction', 'spring', 'rolls']) if (u[k] !== undefined) c[k] = u[k];
  return c;
}
const JOINT_WORDS = /wheel|caster|castor|tyre|tire|roller|fan|rotor|propell|blade|gear|pulley|knob|dial|turbine|impeller|door|lid|hatch|flap|cover|visor|drawer|tray|piston|plunger|rod|slide|ram|telescop|back|recline|lever|handle|pedal|trigger|seat|swivel|turntable|turret|head|platter|carousel/i;

function savedCfgs() {
  try { return JSON.parse(localStorage.getItem('arcfg:' + modelName) || '{}'); } catch { return {}; }
}
function persist() {
  const out = {};
  for (const p of parts) out[p.name] = p.cfg;
  try { localStorage.setItem('arcfg:' + modelName, JSON.stringify(out)); } catch {}
}

function boxInWorldFrame(node) {
  world.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(node);
  return box.applyMatrix4(world.matrixWorld.clone().invert());
}

function unbuildJoint(p) {
  if (!p.pivot) return;
  p.value = 0; applyValue(p);
  p.pivot.updateMatrixWorld(true);
  p.pivot.parent.attach(p.node);
  p.pivot.removeFromParent();
  p.pivot = null;
}
function buildJoint(p) {
  unbuildJoint(p);
  p.value = 0; p.vel = 0;
  if (p.cfg.type === 'fixed') return;
  const box = boxInWorldFrame(p.node), size = box.getSize(V3()), c = box.getCenter(V3());
  const pv = c.clone();
  const f = p.cfg.pivot;
  if (f && f !== 'center') pv[f[1]] = f[0] === '-' ? box.min[f[1]] : box.max[f[1]];
  const q = p.node.parent;
  const pivotW = pv.applyMatrix4(world.matrixWorld);
  const g = new THREE.Group();
  g.name = p.name + ' (joint)';
  q.add(g);
  g.position.copy(q.worldToLocal(pivotW.clone()));
  g.updateMatrixWorld(true);
  g.attach(p.node);
  const axisW = AXES[p.cfg.axis].clone().transformDirection(world.matrixWorld);
  p.axisQ = axisW.applyQuaternion(q.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
  p.parentScale = q.getWorldScale(V3()).x / world.getWorldScale(V3()).x;
  p.restPos = g.position.clone();
  const others = ['x', 'y', 'z'].filter(a => a !== p.cfg.axis).map(a => size[a]);
  p.radius = Math.max(0.01, Math.max(...others) / 2);
  p.pivot = g;
}
function applyValue(p) {
  if (!p.pivot) return;
  if (isRot(p.cfg)) p.pivot.quaternion.setFromAxisAngle(p.axisQ, p.value);
  else p.pivot.position.copy(p.restPos).addScaledVector(p.axisQ, p.value / p.parentScale);
}
function limits(p) {
  if (p.cfg.type === 'hinge') return [THREE.MathUtils.degToRad(+p.cfg.min), THREE.MathUtils.degToRad(+p.cfg.max)];
  if (p.cfg.type === 'slider') return [+p.cfg.min / 100, +p.cfg.max / 100];
  return null;
}

// ---------------------------------------------------------------- loading
function clearModel() {
  for (const p of parts) unbuildJoint(p);
  if (model) world.remove(model);
  model = null; parts = []; partOf.clear(); select(null);
  grabs.clear();
}
function resetPose() {
  Object.assign(obj, { pos: new THREE.Vector2(), vel: new THREE.Vector2(), yaw: 0, yawVel: 0 });
  for (const p of parts) { p.value = 0; p.vel = 0; applyValue(p); }
}

function setModel(root, name) {
  clearModel();
  modelName = name;
  Object.assign(obj, { pos: new THREE.Vector2(), vel: new THREE.Vector2(), yaw: 0, yawVel: 0 });
  world.position.set(0, 0, 0); world.rotation.set(0, 0, 0); world.updateMatrixWorld(true);

  // orientation and units
  const holder = new THREE.Group();
  holder.add(root);
  if ($('zup').checked && name !== 'demo-chair') root.rotation.x -= Math.PI / 2;
  holder.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(holder), size = box.getSize(V3());
  const units = $('units').value;
  const k = name === 'demo-chair' ? 1 : units === 'mm' ? 0.001 : units === 'cm' ? 0.01 : units === 'm' ? 1 : (+$('fitSize').value || 1) / Math.max(size.x, size.y, size.z, 1e-9);
  holder.scale.setScalar(k);
  holder.updateMatrixWorld(true);
  box.setFromObject(holder);
  const c = box.getCenter(V3());
  holder.position.set(-c.x, -box.min.y, -c.z);
  world.add(holder);
  model = holder;
  holder.traverse(m => { if (m.isMesh) { m.castShadow = m.receiveShadow = true; } });

  // candidate parts: children of the first branching node, plus any descendant whose name suggests a joint
  let top = root;
  while (top.children.length === 1 && !top.isMesh) top = top.children[0];
  const cands = new Set(top.children);
  const sig = o => { const g = cfgFromExtras(o) || guessJoint(o.name || '', boxInWorldFrame(o).getSize(V3())); return g ? g.type + g.axis : 'fixed'; };
  root.traverse(o => {
    if (o === root || cands.has(o) || !(JOINT_WORDS.test(o.name || '') || o.userData?.joint)) return;
    // skip e.g. "Seat_cushion" inside "Seat": same motion as an ancestor that is already a part
    const s = sig(o);
    for (let x = o.parent; x; x = x.parent) if (cands.has(x) && sig(x) === s) return;
    cands.add(o);
  });
  const saved = savedCfgs();
  let i = 0;
  for (const node of cands) {
    let name = node.name || `Part ${++i}`;
    while (parts.some(p => p.name === name)) name += "'";
    const size = boxInWorldFrame(node).getSize(V3());
    const cfg = { ...DEFAULT_CFG, ...(saved[name] || cfgFromExtras(node) || guessJoint(name, size) || {}) };
    const p = { name, node, cfg, value: 0, vel: 0 };
    parts.push(p); partOf.set(node, p);
  }
  // build parents before children so nested joints (backrest inside seat) stack correctly
  const depth = n => { let d = 0; for (let x = n; x; x = x.parent) d++; return d; };
  [...parts].sort((a, b) => depth(a.node) - depth(b.node)).forEach(buildJoint);

  const moving = parts.filter(p => p.cfg.type !== 'fixed').length;
  size = box.getSize(V3());
  $('modelInfo').textContent = `${name}: ${parts.length} part(s), ${moving} moving · ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`;
  renderPartList();
  setStatus(moving ? `Loaded ${name}. Pinch a coloured part in the list to work it.` : `Loaded ${name}. No moving parts guessed: tick "click to select" and give parts a motion.`);
}

async function loadFile(file) {
  setStatus('Loading ' + file.name + '…');
  const ext = file.name.split('.').pop().toLowerCase();
  lastSource = { file };
  try {
    let root;
    if (ext === 'glb' || ext === 'gltf') {
      const data = ext === 'glb' ? await file.arrayBuffer() : await file.text();
      root = (await new GLTFLoader().parseAsync(data, '')).scene;
    } else if (ext === 'obj') {
      root = new OBJLoader().parse(await file.text());
      root.traverse(m => { if (m.isMesh) m.material = new THREE.MeshStandardMaterial({ color: 0xb0b4ba, roughness: 0.5, metalness: 0.3 }); });
    } else if (ext === 'stl') {
      const geo = new STLLoader().parse(await file.arrayBuffer());
      geo.computeVertexNormals();
      root = new THREE.Group();
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb0b4ba, roughness: 0.5, metalness: 0.3 }));
      m.name = file.name.replace(/\.[^.]+$/, '');
      root.add(m);
    } else throw new Error('Unsupported file type .' + ext + ' (use GLB, glTF, OBJ or STL)');
    setModel(root, file.name);
  } catch (e) {
    console.error(e);
    setStatus('Could not load model: ' + e.message, true);
  }
}
function loadDemo() { lastSource = { demo: true }; setModel(buildDemoChair(), 'demo-chair'); }

$('file').onchange = e => e.target.files[0] && loadFile(e.target.files[0]);
$('reload').onclick = () => lastSource?.file ? loadFile(lastSource.file) : loadDemo();
$('demo').onclick = loadDemo;
$('resetPose').onclick = resetPose;
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (f.name.endsWith('.json')) loadCfgFile(f); else loadFile(f);
});

// ---------------------------------------------------------------- part list + editor
function renderPartList() {
  const ul = $('partList');
  ul.innerHTML = '';
  for (const p of parts) {
    const li = document.createElement('li');
    li.className = p === selected ? 'sel' : '';
    li.innerHTML = `<span class="n"></span><span class="t ${p.cfg.type}">${p.cfg.type === 'fixed' ? 'fixed' : p.cfg.type + ' ' + p.cfg.axis}</span>`;
    li.querySelector('.n').textContent = p.name;
    li.onclick = () => select(p);
    ul.appendChild(li);
  }
}
function select(p) {
  selected = p;
  if (helper) { scene.remove(helper); helper = null; }
  if (p) { helper = new THREE.BoxHelper(p.node, 0xffd54a); scene.add(helper); }
  $('editor').hidden = !p;
  renderPartList();
  if (!p) return;
  const c = p.cfg;
  $('edName').textContent = p.name;
  $('edType').value = c.type; $('edAxis').value = c.axis; $('edPivot').value = c.pivot;
  $('edMin').value = c.min; $('edMax').value = c.max; $('edFriction').value = c.friction;
  $('edSpring').checked = !!c.spring; $('edRolls').checked = !!c.rolls;
  syncEditorVisibility();
}
function syncEditorVisibility() {
  const t = $('edType').value;
  $('edJoint').hidden = t === 'fixed';
  $('edLimits').hidden = t === 'spin';
  $('edUnit').textContent = t === 'slider' ? 'cm' : '°';
  $('edRollsL').hidden = t !== 'spin';
}
function editorChanged() {
  if (!selected) return;
  const p = selected, old = p.cfg.type;
  Object.assign(p.cfg, {
    type: $('edType').value, axis: $('edAxis').value, pivot: $('edPivot').value,
    min: +$('edMin').value, max: +$('edMax').value, friction: +$('edFriction').value,
    spring: $('edSpring').checked, rolls: $('edRolls').checked,
  });
  if (old !== p.cfg.type && p.cfg.type === 'slider' && Math.abs(p.cfg.max) > 200) { p.cfg.min = 0; p.cfg.max = 20; $('edMin').value = 0; $('edMax').value = 20; }
  syncEditorVisibility();
  // rebuild this joint (and children, whose pivots depend on the parent's rest pose)
  for (const q of parts) if (q !== p && p.node !== q.node && isDescendant(q.node, p.node)) { q.value = 0; applyValue(q); }
  buildJoint(p);
  persist();
  renderPartList();
}
function isDescendant(n, anc) { for (let x = n.parent; x; x = x.parent) if (x === anc) return true; return false; }
for (const id of ['edType', 'edAxis', 'edPivot', 'edMin', 'edMax', 'edFriction', 'edSpring', 'edRolls']) $(id).addEventListener('change', editorChanged);

$('saveCfg').onclick = () => {
  const out = { model: modelName, parts: Object.fromEntries(parts.map(p => [p.name, p.cfg])) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = modelName.replace(/\.[^.]+$/, '') + '.joints.json';
  a.click();
};
async function loadCfgFile(f) {
  try {
    const j = JSON.parse(await f.text());
    localStorage.setItem('arcfg:' + modelName, JSON.stringify(j.parts || j));
    $('reload').click();
  } catch (e) { setStatus('Bad setup file: ' + e.message, true); }
}
$('cfgFile').onchange = e => e.target.files[0] && loadCfgFile(e.target.files[0]);
$('togglePanel').onclick = () => $('panel').classList.toggle('hidden');

// ---------------------------------------------------------------- interaction (mouse + hands share this)
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function rayAt(sx, sy) { ndc.set(sx / innerWidth * 2 - 1, -(sy / innerHeight) * 2 + 1); raycaster.setFromCamera(ndc, camera); }
function hitAt(sx, sy) { if (!model) return null; rayAt(sx, sy); return raycaster.intersectObject(model, true)[0] || null; }
function floorPoint(sx, sy) { rayAt(sx, sy); const p = V3(); return raycaster.ray.intersectPlane(floorPlane, p) ? new THREE.Vector2(p.x, p.z) : null; }
function toScreenPx(v) { const p = v.clone().project(camera); return new THREE.Vector2((p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight); }
// nearest ancestor part (any type) / nearest moving ancestor part
function owningPart(o, movingOnly) { for (let x = o; x; x = x.parent) { const p = partOf.get(x); if (p && (!movingOnly || p.cfg.type !== 'fixed')) return p; } return null; }

const grabs = new Map(); // pointer id -> grab
function grabStart(id, sx, sy) {
  const hit = hitAt(sx, sy);
  if (!hit) return null;
  if ($('editMode').checked) { select(owningPart(hit.object, false)); return null; }
  const part = owningPart(hit.object, true);
  const g = { sx, sy, t: performance.now() };
  if (part) {
    g.part = part; part.grabbed = true;
    g.localGrab = part.pivot.worldToLocal(hit.point.clone());
  } else {
    g.free = true;
    const fp = floorPoint(sx, sy);
    g.offset = fp ? obj.pos.clone().sub(fp) : new THREE.Vector2();
    const others = [...grabs.values()].filter(o => o.free);
    if (others.length) g.twistWith = others[0];
  }
  grabs.set(id, g);
  return g;
}
function grabMove(id, sx, sy, dt) {
  const g = grabs.get(id);
  if (!g) return;
  dt = Math.max(dt, 1 / 120);
  const d = new THREE.Vector2(sx - g.sx, sy - g.sy);
  if (g.part) {
    // Linearise the joint at the grab point: how many screen pixels does one unit of joint motion move it?
    const p = g.part, pv = p.pivot;
    const grabW = pv.localToWorld(g.localGrab.clone());
    const axisW = p.axisQ.clone().transformDirection(pv.parent.matrixWorld);
    let tangent;
    if (isRot(p.cfg)) tangent = axisW.clone().cross(grabW.clone().sub(pv.getWorldPosition(V3())));
    else tangent = axisW.clone().multiplyScalar(world.getWorldScale(V3()).x);
    const eps = 0.01;
    const J = toScreenPx(grabW.clone().addScaledVector(tangent, eps)).sub(toScreenPx(grabW)).divideScalar(eps);
    const j2 = J.lengthSq();
    if (j2 > 25) {
      let dv = d.dot(J) / j2;
      const cap = isRot(p.cfg) ? 0.6 : 0.2;
      dv = THREE.MathUtils.clamp(dv, -cap, cap);
      p.value += dv;
      p.vel = THREE.MathUtils.lerp(p.vel, dv / dt, 0.5);
      const L = limits(p);
      if (L) { p.value = THREE.MathUtils.clamp(p.value, L[0], L[1]); }
      applyValue(p);
    }
  } else if (g.free) {
    const partner = g.twistWith && grabs.get(g.twistWith.id) === g.twistWith ? g.twistWith : [...grabs.values()].find(o => o.free && o.twistWith === g);
    if (partner) {
      // two pointers on the object: turn it by the change in angle between them
      const a0 = Math.atan2(partner.sy - g.sy, partner.sx - g.sx);
      const a1 = Math.atan2(partner.sy - sy, partner.sx - sx);
      let da = a1 - a0; da = Math.atan2(Math.sin(da), Math.cos(da));
      obj.yaw -= da;
      obj.yawVel = THREE.MathUtils.lerp(obj.yawVel, -da / dt, 0.4);
    } else if (g.rotate) {
      obj.yawVel = THREE.MathUtils.lerp(obj.yawVel, d.x / innerWidth * 8 / dt, 0.5);
      obj.yaw += d.x / innerWidth * 8;
    } else {
      const fp = floorPoint(sx, sy);
      if (fp) {
        const target = fp.add(g.offset);
        const v = target.clone().sub(obj.pos).divideScalar(dt);
        obj.vel.lerp(v.clampLength(0, 5), 0.5);
        rollParts(target.clone().sub(obj.pos));
        obj.pos.copy(target);
        clampToBounds();
      }
    }
  }
  g.sx = sx; g.sy = sy;
}
function grabEnd(id) {
  const g = grabs.get(id);
  if (g?.part) g.part.grabbed = false;
  grabs.delete(id);
}

// mouse / touch
let lastPointerT = performance.now();
glCanvas.addEventListener('contextmenu', e => e.preventDefault());
glCanvas.addEventListener('pointerdown', e => {
  const id = 'ptr' + e.pointerId;
  const g = grabStart(id, e.clientX, e.clientY);
  if (g) { g.id = id; if (g.free && (e.shiftKey || e.button === 2)) g.rotate = true; glCanvas.setPointerCapture(e.pointerId); }
});
glCanvas.addEventListener('pointermove', e => {
  const now = performance.now();
  grabMove('ptr' + e.pointerId, e.clientX, e.clientY, (now - lastPointerT) / 1000);
  lastPointerT = now;
  if (!grabs.size) {
    const h = hitAt(e.clientX, e.clientY);
    glCanvas.style.cursor = h ? ($('editMode').checked ? 'pointer' : 'grab') : 'default';
  }
});
const endPtr = e => grabEnd('ptr' + e.pointerId);
glCanvas.addEventListener('pointerup', endPtr);
glCanvas.addEventListener('pointercancel', endPtr);

// ---------------------------------------------------------------- physics
function clampToBounds() {
  if (Math.abs(obj.pos.x) > BOUND.x) { obj.pos.x = Math.sign(obj.pos.x) * BOUND.x; obj.vel.x *= -0.4; }
  if (obj.pos.y < BOUND.zMin) { obj.pos.y = BOUND.zMin; obj.vel.y *= -0.4; }
  if (obj.pos.y > BOUND.zMax) { obj.pos.y = BOUND.zMax; obj.vel.y *= -0.4; }
}
// wheels: rolling without slipping, theta = d . (axis x up) / r
function rollParts(disp) {
  if (disp.lengthSq() === 0) return;
  const d3 = V3(disp.x, 0, disp.y);
  for (const p of parts) {
    if (!p.pivot || p.cfg.type !== 'spin' || !p.cfg.rolls || p.grabbed) continue;
    const axisW = p.axisQ.clone().transformDirection(p.pivot.parent.matrixWorld);
    const side = axisW.clone().cross(UP);
    if (side.lengthSq() < 0.1) continue;
    p.value += d3.dot(side) / p.radius;
    applyValue(p);
  }
}
function stepPhysics(dt) {
  const freeGrabbed = [...grabs.values()].some(g => g.free);
  if (!freeGrabbed) {
    const before = obj.pos.clone();
    obj.pos.addScaledVector(obj.vel, dt);
    clampToBounds();
    rollParts(obj.pos.clone().sub(before));
    obj.yaw += obj.yawVel * dt;
  }
  const fr = +$('friction').value;
  obj.vel.multiplyScalar(Math.exp(-fr * dt));
  obj.yawVel *= Math.exp(-fr * 1.5 * dt);
  world.position.set(obj.pos.x, 0, obj.pos.y);
  world.rotation.y = obj.yaw;

  for (const p of parts) {
    if (!p.pivot || p.grabbed) continue;
    if (p.cfg.spring) p.vel += (-60 * p.value - 4 * p.vel) * dt;
    p.value += p.vel * dt;
    p.vel *= Math.exp(-(+p.cfg.friction) * dt);
    const L = limits(p);
    if (L) {
      if (p.value < L[0]) { p.value = L[0]; p.vel *= -0.3; }
      if (p.value > L[1]) { p.value = L[1]; p.vel *= -0.3; }
    }
    applyValue(p);
  }
  if (helper) helper.update();
}

// ---------------------------------------------------------------- webcam + hand tracking
const video = $('cam');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
let landmarker = null, mirror = true;
function setStatus(t, err) { $('status').textContent = t; $('status').style.color = err ? '#f99' : '#9f9'; }

$('start').onclick = async () => {
  const facing = $('facing').value;
  mirror = facing === 'user';
  video.classList.toggle('mirror', mirror);
  try {
    setStatus('Starting camera…');
    if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: 1280, height: 720 } });
    await video.play();
  } catch (e) { setStatus('Camera blocked: ' + e.message, true); return; }
  if (!landmarker) {
    setStatus('Loading hand tracker…');
    try {
      const { FilesetResolver, HandLandmarker } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
      const fs = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
      landmarker = await HandLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', delegate: 'GPU' },
        runningMode: 'VIDEO', numHands: 2,
      });
    } catch (e) { setStatus('Hand tracker failed (mouse still works): ' + e.message, true); return; }
  }
  setStatus('Hands ready: pinch a part of the model');
};

function lmToScreen(p) {
  const vw = video.videoWidth, vh = video.videoHeight, cw = innerWidth, ch = innerHeight;
  const s = Math.max(cw / vw, ch / vh), ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
  const x = p.x * vw * s + ox;
  return { x: mirror ? cw - x : x, y: p.y * vh * s + oy };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const handMem = {};
let lastVideoTime = -1, handDt = 1 / 30, lastHandT = performance.now();

function trackHands() {
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const now = performance.now(); handDt = (now - lastHandT) / 1000; lastHandT = now;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const res = landmarker.detectForVideo(video, now);
  const seen = new Set();
  const dpr = devicePixelRatio;
  (res.landmarks || []).forEach((raw, i) => {
    const id = 'hand-' + (res.handednesses?.[i]?.[0]?.categoryName || i);
    seen.add(id);
    const lm = raw.map(lmToScreen);
    const tip = lm[8], thumb = lm[4], wrist = lm[0], knuckle = lm[9];
    const size = dist(wrist, knuckle) || 1;
    const mem = handMem[id] || (handMem[id] = { pinch: false });
    const pd = dist(tip, thumb) / size;
    const pinch = mem.pinch ? pd < 0.5 : pd < 0.32;   // hysteresis
    const pt = { x: (tip.x + thumb.x) / 2, y: (tip.y + thumb.y) / 2 };
    // smooth the pinch point a little to hide tracking jitter
    mem.pt = mem.pt ? { x: mem.pt.x * 0.4 + pt.x * 0.6, y: mem.pt.y * 0.4 + pt.y * 0.6 } : pt;
    const sp = mem.pt;
    const open = [8, 12, 16, 20].every(k => dist(lm[k], wrist) > size * 1.6);

    if (pinch && !mem.pinch) { const g = grabStart(id, sp.x, sp.y); if (g) g.id = id; mem.label = g ? (g.part ? g.part.name : 'move / turn') : null; }
    else if (pinch) grabMove(id, sp.x, sp.y, handDt);
    else if (mem.pinch) { grabEnd(id); mem.label = null; }

    // open-palm shove
    if (open && !pinch && mem.palm) {
      const v = { x: knuckle.x - mem.palm.x, y: knuckle.y - mem.palm.y };
      const hit = Math.hypot(v.x, v.y) > 6 && hitAt(knuckle.x, knuckle.y);
      if (hit) {
        const part = owningPart(hit.object, true);
        if (part && part.cfg.type !== 'slider') part.vel += (v.x / innerWidth) * 25 * (isRot(part.cfg) ? 1 : 0.1);
        else {
          const a = floorPoint(mem.palm.x, mem.palm.y), b = floorPoint(knuckle.x, knuckle.y);
          if (a && b) obj.vel.add(b.sub(a).multiplyScalar(0.6 / Math.max(handDt, 1 / 60))).clampLength(0, 4);
        }
      }
    }
    mem.palm = knuckle; mem.pinch = pinch;

    octx.fillStyle = 'rgba(120,200,255,.7)';
    for (const p of lm) { octx.beginPath(); octx.arc(p.x * dpr, p.y * dpr, 3 * dpr, 0, 7); octx.fill(); }
    octx.strokeStyle = pinch ? (mem.label ? '#4f4' : '#fa4') : 'rgba(255,255,255,.6)';
    octx.lineWidth = 3 * dpr;
    octx.beginPath(); octx.arc(sp.x * dpr, sp.y * dpr, (pinch ? 14 : 20) * dpr, 0, 7); octx.stroke();
    if (mem.label) { octx.fillStyle = '#4f4'; octx.font = `${14 * dpr}px system-ui`; octx.fillText(mem.label, (sp.x + 20) * dpr, (sp.y - 16) * dpr); }
  });
  for (const id of Object.keys(handMem)) if (!seen.has(id)) { grabEnd(id); delete handMem[id]; }
}

// ---------------------------------------------------------------- room-light matching
// 1) overall brightness/colour of the camera image drives ambient + key light
// 2) a small, much-brighter-than-average blob (a torch / phone flashlight beam) becomes a virtual
//    spotlight aimed at the same spot, so the object lights up only when the beam is on it.
const PW = 64, PH = 36;
const probe = document.createElement('canvas'); probe.width = PW; probe.height = PH;
const pctx = probe.getContext('2d', { willReadFrequently: true });
const lightTarget = { amb: 1, key: 1.6, color: new THREE.Color(1, 1, 1), dir: V3(1.5, 3, 1.5), torch: 0, torchAt: V3() };
const torch = new THREE.SpotLight(0xfff4e0, 0, 8, 0.32, 0.6, 1);
torch.castShadow = true;
torch.shadow.mapSize.set(1024, 1024);
scene.add(torch, torch.target);
const torchState = { seen: false };

function sampleLight() {
  if (!$('light').checked || video.readyState < 2) {
    Object.assign(lightTarget, { amb: 1, key: 1.6, torch: 0 });
    lightTarget.color.set(1, 1, 1); lightTarget.dir.set(1.5, 3, 1.5);
    return;
  }
  pctx.drawImage(video, 0, 0, PW, PH);
  const d = pctx.getImageData(0, 0, PW, PH).data;
  const n = PW * PH, lum = new Float32Array(n);
  let r = 0, g = 0, b = 0, sum = 0, best = 0;
  for (let i = 0; i < n; i++) {
    const L = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    lum[i] = L; sum += L; if (L > best) best = L;
    r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2];
  }
  const mean = sum / n;
  r /= n * 255; g /= n * 255; b /= n * 255;
  // bright blob = pixels close to the brightest value and well above the average
  const thr = Math.max(best * 0.85, mean + 60);
  let cx = 0, cy = 0, cnt = 0;
  for (let i = 0; i < n; i++) if (lum[i] >= thr) { cx += i % PW; cy += Math.floor(i / PW); cnt++; }
  const blobFrac = cnt / n;
  const contrast = (best - mean) / 255;
  // general light: ambient from average, key light direction from where the brightest area is
  lightTarget.amb = 0.25 + (mean / 255) * 2.2;
  lightTarget.key = 0.4 + (mean / 255) * 1.8;
  const m = Math.max(r, g, b, 1e-3);
  lightTarget.color.setRGB(0.6 + 0.4 * r / m, 0.6 + 0.4 * g / m, 0.6 + 0.4 * b / m);
  if (cnt) {
    const s = lmToScreen({ x: (cx / cnt + 0.5) / PW, y: (cy / cnt + 0.5) / PH });
    lightTarget.dir.set((s.x / innerWidth * 2 - 1) * 2.5, 3.2 - (s.y / innerHeight) * 2.4, 1.8);
    // torch: a small, strong highlight. Aim the virtual torch at what's under that spot.
    if (contrast > 0.3 && blobFrac < 0.2) {
      const hit = hitAt(s.x, s.y);
      let at = hit ? hit.point : null;
      if (!at) { rayAt(s.x, s.y); at = raycaster.ray.intersectPlane(floorPlane, V3()); }
      if (at) { lightTarget.torchAt.copy(at); lightTarget.torch = Math.min(1, (contrast - 0.3) / 0.4 + 0.3); torchState.seen = true; return; }
    }
  }
  lightTarget.torch = 0;
}
// ---------------------------------------------------------------- main loop
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  overlay.width = innerWidth * devicePixelRatio; overlay.height = innerHeight * devicePixelRatio;
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let prev = performance.now(), frame = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - prev) / 1000, 1 / 20); prev = now;
  trackHands();
  if (++frame % 3 === 0) sampleLight();
  const k = Math.min(1, dt * 4);
  hemi.intensity += (lightTarget.amb - hemi.intensity) * k;
  sun.intensity += (lightTarget.key - sun.intensity) * k;
  hemi.color.lerp(lightTarget.color, k); sun.color.lerp(lightTarget.color, k);
  sun.position.lerp(lightTarget.dir, k);
  // the torch is held near the camera, so the virtual spotlight shines from just beside it
  torch.position.copy(camera.position).add(V3(0.15, -0.1, 0));
  torch.target.position.lerp(lightTarget.torchAt, lightTarget.torch > 0 ? Math.min(1, dt * 12) : 0);
  torch.intensity += (lightTarget.torch * 25 - torch.intensity) * Math.min(1, dt * 10);
  stepPhysics(dt);
  renderer.render(scene, camera);
}
loadDemo();
requestAnimationFrame(loop);

// handles for debugging / automated tests
window.__ar = { obj, torch, lightTarget, get parts() { return parts; }, toScreen: v => toScreenPx(V3(...v)), toScreenLocal: v => toScreenPx(world.localToWorld(V3(...v))), hitAt, THREE, world };
