// Hands-on AR: load any 3D model, give its parts joints, and work them with your hands over a live camera feed.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { XREstimatedLight } from 'three/addons/webxr/XREstimatedLight.js';
import { XRHands } from './xrhands.js?v=202610311038';
import { buildDemoChair } from './demo-chair.js?v=202610311038';
import { loadRapier, PhysicsSim } from './physics.js?v=202610311038';

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
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // filmic response, closer to how a phone camera renders
renderer.toneMappingExposure = 1.1;
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

// Lighting = image-based light (reflections + soft fill) + one overhead key light for shadows.
// The environment starts as a neutral studio room and is replaced by the live camera image when available,
// so materials pick up the colours and brightness of the real room.
const pmrem = new THREE.PMREMGenerator(renderer);
const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
let videoEnvRT = null;
const currentEnv = () => (videoEnvRT ? videoEnvRT.texture : roomEnv);
scene.environment = roomEnv;
scene.environmentIntensity = 0.8;
const hemi = new THREE.HemisphereLight(0xffffff, 0x666666, 0.35);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(0.4, 4, 0.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 12 });
scene.add(hemi, sun, sun.target);
const sunDir = sun.position.clone();
// invisible floor that only catches shadows, so the object sits in the camera image
const floor = new THREE.Mesh(new THREE.CircleGeometry(1.2, 48), new THREE.ShadowMaterial({ opacity: 0.3 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const floorPlane = new THREE.Plane(UP.clone(), 0);

// The object: `world` carries floor position + heading; the model sits inside it.
const world = new THREE.Group();
scene.add(world);
const obj = { pos: new THREE.Vector2(), vel: new THREE.Vector2(), yaw: 0, yawVel: 0 };
const home = V3();   // where the object is placed (moves to the tapped surface in AR)
let floorY = 0;
let xr = null;     // active WebXR session state (Android AR)
function setFloor(y) { floorY = y; floor.position.y = y; floorPlane.constant = -y; }
const BOUND = { x: 1.6, zMin: -2, zMax: 0.8 };

// ---------------------------------------------------------------- parts & joints
/** part = { name, node, cfg, pivot, parentQ, axisQ, restPos, value, vel, radius, grabbed } */
let model = null, parts = [], selected = null, modelName = 'demo-chair', lastSource = null;
const partOf = new Map();          // node -> part
let helper = null;

const DEFAULT_CFG = { type: 'fixed', axis: 'y', pivot: 'center', min: -30, max: 30, friction: 1.5, spring: false, rolls: false,
  temp: 22, hardness: 0.7, texture: 'smooth' };   // touch properties, sent with every hand contact (for haptics)
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
  if (!u.joint && u.temp === undefined && u.hardness === undefined) return null;
  const c = u.joint ? { type: String(u.joint) } : {};
  for (const k of ['axis', 'pivot', 'min', 'max', 'friction', 'spring', 'rolls', 'temp', 'hardness', 'texture']) if (u[k] !== undefined) c[k] = u[k];
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
// ---------------------------------------------------------------- physics engine hookup
const sim = new PhysicsSim();
let rapierReady = false;
const physicsOn = () => rapierReady && $('physics').checked && !!model;
function stopPhysics() {
  if (!sim.world) return;
  sim.teardown();
  // carry the pose back into the kinematic state, standing upright
  obj.pos.set(world.position.x, world.position.z);
  obj.yaw = new THREE.Euler().setFromQuaternion(world.quaternion, 'YXZ').y;
  obj.vel.set(0, 0); obj.yawVel = 0;
  world.position.y = floorY; world.rotation.set(0, obj.yaw, 0);
  world.updateMatrixWorld(true);
}
function startPhysics() {
  stopPhysics();
  if (!physicsOn()) return;
  for (const p of parts) { p.value = 0; p.vel = 0; applyValue(p); }
  sim.build(scene, world, parts, floorY);
}
loadRapier().then(() => { rapierReady = true; startPhysics(); })
  .catch(e => { $('physics').checked = false; $('physics').disabled = true; setStatus('Physics engine failed to load: ' + e.message, true); });

function clearModel() {
  sim.teardown();
  for (const p of parts) unbuildJoint(p);
  if (model) world.remove(model);
  model = null; parts = []; partOf.clear(); select(null);
  grabs.clear();
}
function resetPose() {
  sim.teardown();
  Object.assign(obj, { pos: new THREE.Vector2(home.x, home.z), vel: new THREE.Vector2(), yaw: home.yaw || 0, yawVel: 0 });
  world.position.set(home.x, floorY, home.z); world.rotation.set(0, obj.yaw, 0); world.updateMatrixWorld(true);
  for (const p of parts) { p.value = 0; p.vel = 0; applyValue(p); }
  startPhysics();
}

function setModel(root, name) {
  clearModel();
  modelName = name;
  Object.assign(obj, { pos: new THREE.Vector2(), vel: new THREE.Vector2(), yaw: 0, yawVel: 0 });
  world.position.set(0, 0, 0); world.rotation.set(0, 0, 0); world.updateMatrixWorld(true);
  world.visible = !xr || xr.placed;

  // orientation and units
  const holder = new THREE.Group();
  holder.add(root);
  // glTF is Y-up by definition; STL/OBJ straight from CAD are usually Z-up
  if ($('zup').checked && /\.(stl|obj)$/i.test(name)) root.rotation.x -= Math.PI / 2;
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
  startPhysics();
  setStatus(moving ? `Loaded ${name}. Drag or pinch a moving part (green in the list) to work it.` : `Loaded ${name}. No moving parts guessed: tick "click to select" and give parts a motion.`);
}

// Accepts one model file, a .gltf plus its .bin/texture files, or a .zip containing them (e.g. a Sketchfab download).
async function unpack(files) {
  const map = new Map();   // lower-case path and basename -> Blob
  const add = (path, blob) => { const k = path.replace(/\\/g, '/').toLowerCase(); map.set(k, blob); map.set(k.split('/').pop(), blob); };
  const list = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const { unzipSync } = await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js');
      const entries = unzipSync(new Uint8Array(await f.arrayBuffer()));
      for (const [path, bytes] of Object.entries(entries)) {
        if (path.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(path)) continue;
        const blob = new File([bytes], path.split('/').pop());
        add(path, blob); list.push({ path, file: blob });
      }
    } else { add(f.name, f); list.push({ path: f.name, file: f }); }
  }
  const rank = p => ['glb', 'gltf', 'obj', 'stl'].indexOf(p.split('.').pop().toLowerCase());
  const main = list.filter(e => rank(e.path) >= 0).sort((x, y) => rank(x.path) - rank(y.path) || x.path.length - y.path.length)[0];
  return { map, main };
}

async function loadFile(input) {
  const files = input instanceof FileList || Array.isArray(input) ? [...input] : [input];
  lastSource = { file: files };
  setStatus('Loading ' + files.map(f => f.name).join(', ') + '…');
  let urls = [];
  try {
    const { map, main } = await unpack(files);
    if (!main) throw new Error('No .glb, .gltf, .obj or .stl file found');
    const file = main.file, ext = main.path.split('.').pop().toLowerCase();
    const dir = main.path.includes('/') ? main.path.slice(0, main.path.lastIndexOf('/') + 1).toLowerCase() : '';
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => {
      if (/^(data|blob|https?):/.test(url)) return url;
      const clean = decodeURIComponent(url).replace(/^\.\//, '').toLowerCase();
      const blob = map.get(dir + clean) || map.get(clean) || map.get(clean.split('/').pop());
      if (!blob) return url;
      const u = URL.createObjectURL(blob); urls.push(u); return u;
    });
    let root;
    if (ext === 'glb' || ext === 'gltf') {
      const data = ext === 'glb' ? await file.arrayBuffer() : await file.text();
      const gl = new GLTFLoader(manager);
      // compressed GLBs (Draco from Blender, Meshopt from gltfpack) load directly
      gl.setDRACOLoader(new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/'));
      gl.setMeshoptDecoder(MeshoptDecoder);
      try { root = (await gl.parseAsync(data, '')).scene; }
      catch (e) {
        if (/buffer|image|texture/i.test(e.message) && files.length === 1 && ext === 'gltf')
          throw new Error(e.message + ' This .gltf needs its other files: load the whole .zip, or select the .gltf together with its .bin and textures.');
        throw e;
      }
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
    setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), 10000);
  } catch (e) {
    console.error(e);
    setStatus('Could not load model: ' + e.message, true);
  }
}
function loadDemo() { lastSource = { demo: true }; setModel(buildDemoChair(), 'demo-chair'); }

$('file').onchange = e => e.target.files.length && loadFile([...e.target.files]);
$('reload').onclick = () => lastSource?.file ? loadFile(lastSource.file) : loadDemo();
$('demo').onclick = loadDemo;
$('resetPose').onclick = resetPose;
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault();
  const fs = [...e.dataTransfer.files];
  if (!fs.length) return;
  if (fs.length === 1 && fs[0].name.endsWith('.json')) loadCfgFile(fs[0]); else loadFile(fs);
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
  $('edTemp').value = c.temp ?? 22; $('edHard').value = c.hardness ?? 0.7; $('edTexture').value = c.texture || 'smooth';
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
  stopPhysics();
  Object.assign(p.cfg, {
    type: $('edType').value, axis: $('edAxis').value, pivot: $('edPivot').value,
    min: +$('edMin').value, max: +$('edMax').value, friction: +$('edFriction').value,
    spring: $('edSpring').checked, rolls: $('edRolls').checked,
    temp: +$('edTemp').value, hardness: +$('edHard').value, texture: $('edTexture').value,
  });
  if (old !== p.cfg.type && p.cfg.type === 'slider' && Math.abs(p.cfg.max) > 200) { p.cfg.min = 0; p.cfg.max = 20; $('edMin').value = 0; $('edMax').value = 20; }
  syncEditorVisibility();
  // rebuild this joint (and children, whose pivots depend on the parent's rest pose)
  for (const q of parts) if (q !== p && p.node !== q.node && isDescendant(q.node, p.node)) { q.value = 0; applyValue(q); }
  buildJoint(p);
  persist();
  renderPartList();
  startPhysics();
}
function isDescendant(n, anc) { for (let x = n.parent; x; x = x.parent) if (x === anc) return true; return false; }
for (const id of ['edType', 'edAxis', 'edPivot', 'edMin', 'edMax', 'edFriction', 'edSpring', 'edRolls', 'edTemp', 'edHard', 'edTexture']) $(id).addEventListener('change', editorChanged);

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
const viewCamera = () => (renderer.xr.isPresenting ? renderer.xr.getCamera() : camera);
function hitAt(sx, sy) {
  if (!model) return null;
  rayAt(sx, sy);
  return hitRay();
}
function hitRay() {
  if (!model || !world.visible) return null;
  const targets = sim.world ? sim.roots() : [model];
  return raycaster.intersectObjects(targets, true)[0] || null;
}
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
  if (sim.world) {
    // physics: a spring pulls the grabbed point toward your hand; joints and gravity do the rest
    if (!sim.grabStart(id, hit, viewCamera())) return null;
    g.physics = true; g.part = part; g.free = !part;
    grabs.set(id, g);
    return g;
  }
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
  if (g.physics) {
    if (g.rotate) sim.twist(d.x / innerWidth * 8 / dt);
    else { rayAt(sx, sy); sim.grabMove(id, raycaster.ray); }
  } else if (g.part) {
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
  sim.grabEnd(id);
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
  if (sim.world) {
    sim.step(dt);
    if (sim.lost) { sim.lost = false; resetPose(); setStatus('The object left the scene, so it was put back.'); }
    if (helper) { helper.visible = $('editMode').checked && !xr; helper.update(); }
    return;
  }
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
  world.position.set(obj.pos.x, floorY, obj.pos.y);
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
  if (helper) { helper.visible = $('editMode').checked && !xr; helper.update(); }
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
  setStatus('Loading hand tracker…');
  try { await ensureLandmarker(); } catch (e) { setStatus('Hand tracker failed (mouse still works): ' + e.message, true); return; }
  setStatus('Hands ready: pinch a part of the model');
};
let landmarkerP = null;
function ensureLandmarker() {
  landmarkerP ||= (async () => {
    const { FilesetResolver, HandLandmarker } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
    const fs = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    landmarker = await HandLandmarker.createFromOptions(fs, {
      baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', delegate: 'GPU' },
      runningMode: 'VIDEO', numHands: 2,
    });
    return landmarker;
  })();
  landmarkerP.catch(() => { landmarkerP = null; });
  return landmarkerP;
}

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
      if (hit && sim.world) {
        rayAt(mem.palm.x, mem.palm.y); const a = raycaster.ray.at(hit.distance, V3());
        rayAt(knuckle.x, knuckle.y); const b = raycaster.ray.at(hit.distance, V3());
        const dir = b.sub(a);
        sim.shove(hit, dir, dir.length() / Math.max(handDt, 1 / 60));
      } else if (hit) {
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
const lightTarget = { amb: 0.35, key: 1.6, env: 0.8, color: new THREE.Color(1, 1, 1), dir: V3(1.5, 3, 1.5), torch: 0, torchAt: V3() };
const torch = new THREE.SpotLight(0xfff4e0, 0, 8, 0.32, 0.6, 1);
torch.castShadow = true;
torch.shadow.mapSize.set(1024, 1024);
scene.add(torch, torch.target);
const torchState = { seen: false };

// Use the live camera image as the environment map (blurred, stretched to a panorama).
// Not physically exact, but reflections and fill light now carry the real room's colours.
const envCanvas = document.createElement('canvas'); envCanvas.width = 256; envCanvas.height = 128;
const ectx = envCanvas.getContext('2d');
const envTex = new THREE.CanvasTexture(envCanvas);
envTex.mapping = THREE.EquirectangularReflectionMapping; envTex.colorSpace = THREE.SRGBColorSpace;
function updateVideoEnv() {
  if (!$('light').checked || video.readyState < 2 || xr) {
    if (videoEnvRT && !xr) { videoEnvRT.dispose(); videoEnvRT = null; scene.environment = roomEnv; }
    return;
  }
  ectx.filter = 'blur(6px)';
  // mirror the frame side by side so the panorama wraps without a seam
  ectx.drawImage(video, 0, 0, 128, 128);
  ectx.save(); ectx.scale(-1, 1); ectx.drawImage(video, -256, 0, 128, 128); ectx.restore();
  envTex.needsUpdate = true;
  const rt = pmrem.fromEquirectangular(envTex);
  videoEnvRT?.dispose();
  videoEnvRT = rt; scene.environment = rt.texture;
}

function sampleLight() {
  if (!$('light').checked || video.readyState < 2) {
    Object.assign(lightTarget, { amb: 0.35, key: 1.6, env: 0.8, torch: 0 });
    lightTarget.color.set(1, 1, 1); lightTarget.dir.set(0.4, 4, 0.5);
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
  // general light: reflections/fill from the camera image (see updateVideoEnv), brightness from the average.
  // Rooms are lit mostly from above, so the key light stays high and only leans toward the bright side.
  lightTarget.amb = 0.1 + (mean / 255) * 0.5;
  lightTarget.env = 0.3 + (mean / 255) * 1.6;
  lightTarget.key = 0.5 + (mean / 255) * 1.6;
  const m = Math.max(r, g, b, 1e-3);
  lightTarget.color.setRGB(0.6 + 0.4 * r / m, 0.6 + 0.4 * g / m, 0.6 + 0.4 * b / m);
  if (cnt) {
    const s = lmToScreen({ x: (cx / cnt + 0.5) / PW, y: (cy / cnt + 0.5) / PH });
    lightTarget.dir.set((s.x / innerWidth * 2 - 1) * 0.8, 4, 0.5);
    // torch: a small, strong highlight. Aim the virtual torch at what's under that spot.
    // (bright windows and sunlit walls are big or not saturated; a torch beam is small and clipped white)
    if (best > 240 && contrast > 0.45 && blobFrac < 0.05) {
      const hit = hitAt(s.x, s.y);
      let at = hit ? hit.point : null;
      if (!at) { rayAt(s.x, s.y); at = raycaster.ray.intersectPlane(floorPlane, V3()); }
      if (at) { lightTarget.torchAt.copy(at); lightTarget.torch = Math.min(1, (contrast - 0.45) / 0.3 + 0.4); torchState.seen = true; return; }
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
function loop(now, xrFrame) {
  const dt = Math.min((now - prev) / 1000, 1 / 20); prev = now;
  if (xrFrame && xr) { try { xrUpdate(xrFrame); } catch (e) { console.error(e); arHint('AR error: ' + e.message); } }
  else { trackHands(); if (++frame % 3 === 0) sampleLight(); if (frame % 45 === 0) updateVideoEnv(); }
  const k = Math.min(1, dt * 4);
  hemi.intensity += (lightTarget.amb - hemi.intensity) * k;
  scene.environmentIntensity += (lightTarget.env - scene.environmentIntensity) * k;
  sun.intensity += (lightTarget.key - sun.intensity) * k;
  hemi.color.lerp(lightTarget.color, k); sun.color.lerp(lightTarget.color, k);
  sunDir.lerp(lightTarget.dir, k);
  // keep the key light, its shadow camera and the shadow-catching floor centred on the object
  sun.target.position.set(world.position.x, floorY, world.position.z);
  sun.position.copy(sun.target.position).add(sunDir);
  floor.position.x = world.position.x; floor.position.z = world.position.z;
  // the torch is held near the camera, so the virtual spotlight shines from just beside it
  torch.position.copy(viewCamera().position).add(V3(0.15, -0.1, 0));
  torch.target.position.lerp(lightTarget.torchAt, lightTarget.torch > 0 ? Math.min(1, dt * 12) : 0);
  torch.intensity += (lightTarget.torch * 25 - torch.intensity) * Math.min(1, dt * 10);
  stepPhysics(dt);
  renderer.render(scene, camera);
}
loadDemo();
renderer.setAnimationLoop(loop);

// ---------------------------------------------------------------- Android AR (WebXR)
// Chrome on Android finds real surfaces (hit-test). Tap a surface to place the object at true scale;
// then touch and drag it: the drag is a spring on the touched point, so physics does the rest.
// Plain glossy floors often give no hit-test results, so when the device reports its floor height
// ('local-floor') we fall back to placing on that estimated floor where the phone is pointing.
const reticle = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
reticle.matrixAutoUpdate = false; reticle.visible = false;
scene.add(reticle);
// The phone's own light estimate (ARCore): directional light + light probe + reflections
const xrLight = new XREstimatedLight(renderer);
xrLight.directionalLight.castShadow = false;   // our own overhead light casts the shadow (it follows the object)
xrLight.directionalLight.shadow.mapSize.set(1024, 1024);
xrLight.addEventListener('estimationstart', () => {
  scene.add(xrLight); hemi.visible = false; lightTarget.key = 0.7;
  if (xrLight.environment) scene.environment = xrLight.environment;
});
xrLight.addEventListener('estimationend', () => { scene.remove(xrLight); hemi.visible = true; lightTarget.key = 1.6; scene.environment = currentEnv(); });

if (navigator.xr?.isSessionSupported) {
  navigator.xr.isSessionSupported('immersive-ar').then(ok => {
    if (ok) $('enterAR').hidden = false;
    else $('arNote').textContent = 'AR mode (real surfaces, true scale) needs Chrome on an Android phone with Google Play Services for AR.';
  }).catch(() => {});
} else $('arNote').textContent = 'AR mode (real surfaces, true scale) needs Chrome on an Android phone, opened over HTTPS.';
if (/Brave/i.test(navigator.userAgent) || navigator.brave) $('arNote').textContent = 'Tip: AR mode works best in Chrome. Other browsers may not detect surfaces.';

const arHint = t => { $('arHint').textContent = t; };
$('enterAR').onclick = async () => {
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      // Note: no 'depth-sensing' here. three.js reads GPU depth every frame when that feature is on, which throws
      // on phones that only offer CPU depth and stops the whole AR frame loop. Hand depth is estimated instead.
      optionalFeatures: ['hit-test', 'local-floor', 'dom-overlay', 'light-estimation', 'camera-access'],
      domOverlay: { root: $('arOverlay') },
    });
    const has = f => !session.enabledFeatures || session.enabledFeatures.includes(f);
    const floorMode = session.enabledFeatures ? session.enabledFeatures.includes('local-floor') : false;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType(floorMode ? 'local-floor' : 'local');
    await renderer.xr.setSession(session);
    const refSpace = renderer.xr.getReferenceSpace();
    let hitSource = null;
    if (has('hit-test')) {
      try { hitSource = await session.requestHitTestSource({ space: await session.requestReferenceSpace('viewer') }); } catch (e) { console.warn(e); }
    }
    xr = { session, refSpace, hitSource, floorMode, placed: false, held: new Map(), target: null, targetKind: null, frames: 0, hits: 0 };
    if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop());
    video.hidden = true; $('panel').classList.add('hidden'); $('togglePanel').hidden = true;
    $('arOverlay').hidden = false;
    arHint('Point at the floor and move the phone slowly…');
    $('physics').checked = true;
    sim.teardown(); world.visible = false;
    lightTarget.amb = 0.35; lightTarget.key = 1.6; lightTarget.env = 0.8; lightTarget.torch = 0; lightTarget.dir.set(0.4, 4, 0.5);
    videoEnvRT?.dispose(); videoEnvRT = null; scene.environment = roomEnv;
    session.addEventListener('selectstart', xrSelectStart);
    session.addEventListener('selectend', e => { const id = 'xr' + inputId(e.inputSource); grabEnd(id); xr?.held.delete(e.inputSource); });
    session.addEventListener('end', xrEnded);
    // hand tracking on the AR camera image (loads in the background)
    ensureLandmarker().then(lm => { if (xr?.session === session) xrHands.start(session, lm); })
      .catch(e => { xr && (xr.handError = e.message); });
  } catch (e) { setStatus('Could not start AR: ' + e.message, true); }
};
$('exitAR').addEventListener('beforexrselect', e => e.preventDefault());
$('exitAR').onclick = () => xr?.session.end();
$('placeAgain').addEventListener('beforexrselect', e => e.preventDefault());
$('placeAgain').onclick = () => { if (xr) { xr.placed = false; sim.teardown(); world.visible = false; arHint('Tap to place.'); } };

const inputIds = new WeakMap(); let nextInputId = 1;
function inputId(src) { if (!inputIds.has(src)) inputIds.set(src, nextInputId++); return inputIds.get(src); }
function rayFromSpace(space, frame) {
  const pose = frame.getPose(space, xr.refSpace);
  if (!pose) return false;
  const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
  raycaster.ray.origin.setFromMatrixPosition(m);
  raycaster.ray.direction.set(0, 0, -1).transformDirection(m);
  return true;
}
function xrSelectStart(e) {
  if (!xr) return;
  const frame = e.frame, src = e.inputSource;
  if (xr.placed && rayFromSpace(src.targetRaySpace, frame)) {
    const id = 'xr' + inputId(src);
    const hit = hitRay();
    if (hit) {
      const part = owningPart(hit.object, true);
      if (sim.world && sim.grabStart(id, hit, viewCamera())) { grabs.set(id, { physics: true, part, free: !part, sx: 0, sy: 0 }); xr.held.set(src, id); }
    }
    return;   // once placed, taps never move it; use "Place again"
  }
  if (!xr.placed) {
    // a tap places at the current target; with no target, 1.5 m ahead at the estimated floor
    let p = xr.target;
    if (!p && rayFromSpace(src.targetRaySpace, frame)) {
      const r = raycaster.ray, fwd = V3(r.direction.x, 0, r.direction.z).normalize();
      p = r.origin.clone().addScaledVector(fwd, 1.5); p.y = xr.floorMode ? 0 : r.origin.y - 1.4;
    }
    if (p) placeAt(p);
  }
}
function placeAt(pos) {
  sim.teardown();
  setFloor(pos.y);
  const cam = viewCamera().getWorldPosition(V3());
  home.copy(pos); home.yaw = Math.atan2(cam.x - pos.x, cam.z - pos.z);   // front of the model faces you
  xr.placed = true; world.visible = true; reticle.visible = false;
  resetPose();
  arHint('Placed. Drag the object to push, tip or roll it; drag a moving part to work it.');
}
function xrUpdate(frame) {
  xr.frames++;
  if (!xr.placed) {
    let found = null, kind = null;
    const res = xr.hitSource ? frame.getHitTestResults(xr.hitSource) : [];
    if (res.length) {
      const m = new THREE.Matrix4().fromArray(res[0].getPose(xr.refSpace).transform.matrix);
      found = V3().setFromMatrixPosition(m); kind = 'surface'; xr.hits++;
    } else if (xr.floorMode) {
      const vp = frame.getViewerPose(xr.refSpace);
      if (vp) {
        const m = new THREE.Matrix4().fromArray(vp.transform.matrix);
        const o = V3().setFromMatrixPosition(m), d = V3(0, 0, -1).transformDirection(m);
        if (d.y < -0.1) { const t = -o.y / d.y; if (t > 0 && t < 6) { found = o.addScaledVector(d, t); kind = 'floor'; } }
      }
    }
    xr.target = found; xr.targetKind = kind;
    if (found) {
      reticle.matrix.makeTranslation(found.x, found.y, found.z);
      reticle.matrixWorldNeedsUpdate = true;
      reticle.material.color.set(kind === 'surface' ? 0xffffff : 0xffd54a);
      reticle.visible = true;
    } else reticle.visible = false;
    if (xr.frames % 15 === 0) arHint(
      kind === 'surface' ? 'Surface found: tap to place.'
      : kind === 'floor' ? 'Using the estimated floor (yellow ring): tap to place. Plain shiny floors are hard to detect.'
      : xr.hitSource || xr.floorMode ? 'Point the phone down at the floor and move it slowly… (or tap to place 1.5 m ahead)'
      : 'This browser does not report surfaces. Tap to place 1.5 m ahead, or try Chrome.');
  }
  for (const [src, id] of xr.held) if (rayFromSpace(src.targetRaySpace, frame)) sim.grabMove(id, raycaster.ray);
  if (xr.placed) {
    // hand tracking must never break placement or rendering
    try { applyXRHands(xrHands.update(frame, xr.refSpace)); }
    catch (e) { console.error(e); xrHands.status = 'error: ' + e.message; }
    if (xr.frames % 15 === 0) {
      const hs = xrHands.status;
      const touching = lastTouch.length ? ' · ' + lastTouch.map(t => `${t.finger} ${t.force.toFixed(1)} N`).join(', ') : '';
      arHint(hs === 'no-camera' ? 'Placed. This phone/browser does not share the AR camera, so use touch: drag the object.'
        : hs === 'off' || hs === 'waiting' ? (xr.handError ? 'Hand tracker failed: ' + xr.handError : 'Placed. Loading hand tracking…')
        : `Hands: ${hs}. Reach in and push it, or pinch it to grab${touching}`);
    }
  }
}

// ---- real hands in AR: colliders, pinch-grab, occlusion, haptic contact events
const xrHands = new XRHands(renderer);
const TIPS = [4, 8, 12, 16, 20], FINGER = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
// invisible spheres that write depth only: the real hand hides the virtual object behind it
const OCC_PER_HAND = 21 + BONES.length;
const occluder = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ colorWrite: false }), OCC_PER_HAND * 2);
occluder.renderOrder = -1; occluder.frustumCulled = false; occluder.count = 0;
const tipDots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.007, 10, 8), new THREE.MeshBasicMaterial({ color: 0x55ddff }), 10);
tipDots.frustumCulled = false; tipDots.count = 0;
scene.add(occluder, tipDots);
const handGrab = new Map();   // hand id -> { offset }
let lastTouch = [];
const tmpM4 = new THREE.Matrix4();

function applyXRHands(hands) {
  const live = new Set();
  let oi = 0, ti = 0;
  for (const h of hands || []) {
    live.add(h.id);
    const P = h.pts;
    // occluders + fingertip dots
    for (let k = 0; k < 21; k++) occluder.setMatrixAt(oi++, tmpM4.makeScale(0.011, 0.011, 0.011).setPosition(P[k]));
    for (const [a, b] of BONES) occluder.setMatrixAt(oi++, tmpM4.makeScale(0.01, 0.01, 0.01).setPosition(P[a].clone().lerp(P[b], 0.5)));
    for (const k of TIPS) tipDots.setMatrixAt(ti++, tmpM4.makeTranslation(P[k].x, P[k].y, P[k].z));
    if (!sim.world) continue;
    // physics colliders: fingertips, last finger joints, palm
    const palm = [0, 5, 9, 13, 17].reduce((v, k) => v.add(P[k]), V3()).multiplyScalar(0.2);
    const spheres = TIPS.map((k, f) => ({ p: P[k], r: 0.011, finger: FINGER[f] }))
      .concat([3, 7, 11, 15, 19].map((k, f) => ({ p: P[k], r: 0.01, finger: FINGER[f] })))
      .concat([{ p: palm, r: 0.035, finger: 'palm' }]);
    sim.setHand(h.id, spheres);
    // pinch to grab: only if the pinch is on (or very near) the object's surface
    const gid = 'xrhand-' + h.id;
    const g = handGrab.get(h.id);
    if (h.pinch && !g) {
      raycaster.ray.origin.copy(h.origin);
      raycaster.ray.direction.copy(h.pinchPoint).sub(h.origin).normalize();
      const hit = hitRay();
      const reach = h.origin.distanceTo(h.pinchPoint);
      if (hit && Math.abs(hit.distance - reach) < 0.12 && sim.grabStart(gid, hit, viewCamera())) {
        handGrab.set(h.id, { offset: hit.point.clone().sub(h.pinchPoint) });
        sim.setHandEnabled(h.id, false);
      }
    } else if (h.pinch && g) {
      sim.setGrabTarget(gid, h.pinchPoint.clone().add(g.offset));
    } else if (!h.pinch && g) {
      sim.grabEnd(gid); handGrab.delete(h.id); sim.setHandEnabled(h.id, true);
    }
  }
  occluder.count = oi; occluder.instanceMatrix.needsUpdate = true;
  tipDots.count = ti; tipDots.instanceMatrix.needsUpdate = true;
  // hands that disappeared
  for (const id of [...handGrab.keys()]) if (!live.has(id)) { sim.grabEnd('xrhand-' + id); handGrab.delete(id); sim.setHandEnabled(id, true); }
  for (const id of sim.hands?.keys() || []) if (!live.has(id)) sim.setHand(id, null);
  emitContacts();
}

// Haptics hook: every frame with contact, dispatches window 'haptics' events, e.g.
// { hand: 'Right', finger: 'index', force: 2.1, part: 'Seat', temp: 22, hardness: 0.7, texture: 'smooth' }
// A glove driver (Web Bluetooth) can listen with: addEventListener('haptics', e => send(e.detail))
function emitContacts() {
  const raw = sim.world ? sim.takeContacts() : [];
  const byFinger = new Map();
  for (const c of raw) {
    const k = c.hand + '/' + c.finger;
    if (!byFinger.has(k) || byFinger.get(k).force < c.force) byFinger.set(k, c);
  }
  lastTouch = [...byFinger.values()].map(c => {
    const cfg = c.rec.part ? c.rec.part.cfg : (parts.find(p => p.cfg.type === 'fixed')?.cfg || DEFAULT_CFG);
    return { hand: c.hand, finger: c.finger, force: c.force, part: c.rec.part ? c.rec.part.name : 'body', temp: cfg.temp ?? 22, hardness: cfg.hardness ?? 0.7, texture: cfg.texture || 'smooth' };
  });
  if (lastTouch.length) dispatchEvent(new CustomEvent('haptics', { detail: lastTouch }));
}
function xrEnded() {
  xrHands.stop(); applyXRHands([]); handGrab.clear();
  xr = null; reticle.visible = false;
  renderer.xr.enabled = false;
  video.hidden = false; $('panel').classList.remove('hidden'); $('togglePanel').hidden = false; $('arOverlay').hidden = true;
  setFloor(0); home.set(0, 0, 0); home.yaw = 0; world.visible = true;
  resetPose(); resize();
  setStatus('Left AR mode.');
}

// handles for debugging / automated tests
window.__ar = { applyXRHands, get lastTouch() { return lastTouch; }, sim, obj, torch, lightTarget, get parts() { return parts; }, toScreen: v => toScreenPx(V3(...v)), toScreenLocal: v => toScreenPx(world.localToWorld(V3(...v))), hitAt, THREE, world };
$('physics').onchange = () => ($('physics').checked ? startPhysics() : stopPhysics());
