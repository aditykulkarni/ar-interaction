// Rigid-body physics for the loaded model, using Rapier (WASM).
// The model becomes a small multibody: one root body for everything fixed, one body per moving part,
// connected by revolute (hinge / spin) or prismatic (slide) joints. Grabbing applies a spring force at
// the grabbed point, so pushing high up tips the object over, and pushing the base rolls it on its wheels.
import * as THREE from 'three';

const RAPIER_URL = 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js';
let R = null;
export async function loadRapier() {
  if (!R) {
    const m = await import(RAPIER_URL);
    R = m.default || m;
    await R.init();
  }
  return R;
}

const tmpM = new THREE.Matrix4(), tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
const v3 = o => new THREE.Vector3(o.x, o.y, o.z);
const MAX_POINTS = 200;

export class PhysicsSim {
  constructor() { this.world = null; this.recs = []; this.saved = []; this.acc = 0; this.grabs = new Map(); }

  /**
   * world: THREE.Group holding the model (driven by the root body)
   * parts: app parts; those with a .pivot are moving joints
   */
  build(scene, world, parts, floorY = 0) {
    this.floorY = floorY;
    this.teardown();
    this.scene = scene; this.three = world;
    const W = this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    W.timestep = 1 / 120;
    W.createCollider(R.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, floorY - 0.5, 0).setFriction(1.0));
    scene.updateMatrixWorld(true);

    const moving = parts.filter(p => p.pivot);
    // parent part of each moving part, in the original hierarchy
    const parentOf = p => { for (let x = p.pivot.parent; x; x = x.parent) { const q = moving.find(m => m.pivot === x); if (q) return q; } return null; };
    const parentMap = new Map(moving.map(p => [p, parentOf(p)]));
    const depth = p => { let d = 0; for (let q = parentMap.get(p); q; q = parentMap.get(q)) d++; return d; };
    const ordered = [...moving].sort((a, b) => depth(a) - depth(b));

    // root body
    const root = { obj: world, part: null };
    root.body = W.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(world.position.x, world.position.y, world.position.z)
      .setRotation(world.quaternion).setLinearDamping(0.05).setAngularDamping(0.2));
    this.recs = [root];
    const recOfPart = new Map();

    // detach every moving pivot into its own "driver" group in the scene, keeping world transforms.
    // The driver starts with the same rotation as its parent body so joint axes match in both local frames.
    for (const p of ordered) {
      const parentRec = parentMap.get(p) ? recOfPart.get(parentMap.get(p)) : root;
      const piv = p.pivot;
      this.saved.push({ piv, parent: piv.parent, pos: piv.position.clone(), quat: piv.quaternion.clone(), scale: piv.scale.clone() });
      const driver = new THREE.Group();
      driver.name = p.name + ' (body)';
      piv.getWorldPosition(driver.position);
      parentRec.obj.getWorldQuaternion(driver.quaternion);
      scene.add(driver);
      driver.updateMatrixWorld(true);
      driver.attach(piv);
      const rec = { obj: driver, part: p, parent: parentRec };
      rec.body = W.createRigidBody(R.RigidBodyDesc.dynamic()
        .setTranslation(driver.position.x, driver.position.y, driver.position.z)
        .setRotation(driver.quaternion).setAngularDamping(0.05));
      this.recs.push(rec); recOfPart.set(p, rec);
    }
    scene.updateMatrixWorld(true);

    // colliders: convex hulls of the meshes that now belong to each body
    for (const rec of this.recs) this.addColliders(rec);

    // joints
    for (const rec of this.recs) {
      if (!rec.part) continue;
      const p = rec.part, c = p.cfg;
      const parentObj = rec.parent.obj;
      const anchor1 = parentObj.worldToLocal(rec.obj.getWorldPosition(new THREE.Vector3()));
      // axis in world, then in the parent body's frame (same as the child's at rest)
      const axisW = p.axisQ.clone().transformDirection(this.saved.find(s => s.piv === p.pivot).parent.matrixWorld);
      const axisL = axisW.applyQuaternion(parentObj.getWorldQuaternion(tmpQ).invert()).normalize();
      const rot = c.type !== 'slider';
      const data = rot ? R.JointData.revolute(anchor1, { x: 0, y: 0, z: 0 }, axisL) : R.JointData.prismatic(anchor1, { x: 0, y: 0, z: 0 }, axisL);
      const j = W.createImpulseJoint(data, rec.parent.body, rec.body, true);
      j.setContactsEnabled(false);
      if (c.type === 'hinge') j.setLimits(THREE.MathUtils.degToRad(+c.min), THREE.MathUtils.degToRad(+c.max));
      if (c.type === 'slider') j.setLimits(+c.min / 100, +c.max / 100);
      const m = rec.body.mass();
      if (c.spring) j.configureMotorPosition(0, 40 * m + 2, 4 * m + 0.2);
      else j.configureMotorVelocity(0, (+c.friction) * 0.02 * m + 0.001);
      rec.joint = j;
    }
    this.totalMass = this.recs.reduce((s, r) => s + r.body.mass(), 0);
    this.objOf = new Map(this.recs.map(r => [r.obj, r]));
  }

  addColliders(rec) {
    const obj = rec.obj;
    // body frame = obj position + rotation (no scale)
    const inv = new THREE.Matrix4().compose(obj.getWorldPosition(new THREE.Vector3()), obj.getWorldQuaternion(new THREE.Quaternion()), new THREE.Vector3(1, 1, 1)).invert();
    const meshes = [];
    obj.traverse(m => { if (m.isMesh && m.geometry?.attributes?.position) meshes.push(m); });
    const pointsOf = (mesh, budget) => {
      const pos = mesh.geometry.attributes.position, n = pos.count;
      const step = Math.max(1, Math.floor(n / budget));
      tmpM.multiplyMatrices(inv, mesh.matrixWorld);
      const out = [];
      for (let i = 0; i < n; i += step) { tmpV.fromBufferAttribute(pos, i).applyMatrix4(tmpM); out.push(tmpV.x, tmpV.y, tmpV.z); }
      return out;
    };
    const wheel = rec.part?.cfg.rolls;
    const add = pts => {
      if (pts.length < 12) return;
      let desc = R.ColliderDesc.convexHull(new Float32Array(pts));
      if (!desc) {  // flat/degenerate: use its bounding box
        const b = new THREE.Box3().setFromArray(pts), s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
        desc = R.ColliderDesc.cuboid(Math.max(s.x / 2, 0.002), Math.max(s.y / 2, 0.002), Math.max(s.z / 2, 0.002)).setTranslation(c.x, c.y, c.z);
      }
      desc.setDensity(250).setFriction(wheel ? 0.6 : 0.8).setRestitution(0.05);
      this.world.createCollider(desc, rec.body);
    };
    if (meshes.length > 40) add(meshes.flatMap(m => pointsOf(m, Math.ceil(MAX_POINTS * 4 / meshes.length))));
    else for (const m of meshes) add(pointsOf(m, MAX_POINTS));
    if (!meshes.length) this.world.createCollider(R.ColliderDesc.ball(0.01).setDensity(250), rec.body);
  }

  teardown() {
    if (!this.world) return;
    for (const s of this.saved.reverse()) {
      const driver = s.piv.parent;
      s.parent.add(s.piv);
      s.piv.position.copy(s.pos); s.piv.quaternion.copy(s.quat); s.piv.scale.copy(s.scale);
      driver?.removeFromParent();
    }
    this.saved = []; this.recs = []; this.grabs.clear();
    this.world.free(); this.world = null;
  }

  recFor(object) { for (let x = object; x; x = x.parent) { const r = this.objOf.get(x); if (r) return r; } return null; }
  roots() { return this.recs.map(r => r.obj); }

  // ---- interaction: spring from the grabbed point to a target on a camera-facing plane
  grabStart(id, hit, camera) {
    const rec = this.recFor(hit.object);
    if (!rec) return null;
    const local = rec.obj.worldToLocal(hit.point.clone());
    const n = camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, hit.point);
    const g = { rec, local, plane, target: hit.point.clone() };
    this.grabs.set(id, g);
    return g;
  }
  grabMove(id, ray) { const g = this.grabs.get(id); if (g) ray.intersectPlane(g.plane, g.target); }
  grabEnd(id) { this.grabs.delete(id); }
  twist(angleVel) {
    const b = this.recs[0].body;
    b.applyTorqueImpulse({ x: 0, y: angleVel * this.totalMass * 0.02, z: 0 }, true);
  }
  shove(hit, dir, speed) {
    const rec = this.recFor(hit.object);
    if (!rec || dir.lengthSq() === 0) return;
    const imp = dir.clone().normalize().multiplyScalar(Math.min(speed, 3) * this.totalMass * 0.15);
    rec.body.applyImpulseAtPoint(imp, hit.point, true);
  }

  step(dt) {
    if (!this.world) return;
    this.acc = Math.min(this.acc + dt, 0.1);
    const h = this.world.timestep;
    while (this.acc >= h) {
      for (const g of this.grabs.values()) this.applyGrab(g, h);
      this.world.step();
      this.acc -= h;
    }
    for (const r of this.recs) {
      const t = r.body.translation(), q = r.body.rotation();
      r.obj.position.set(t.x, t.y, t.z);
      r.obj.quaternion.set(q.x, q.y, q.z, q.w);
      // safety net: if it falls through or flies away, put it back
      if (t.y < this.floorY - 2 || Math.abs(t.x) > 20 || Math.abs(t.z) > 20) this.lost = true;
    }
  }
  applyGrab(g, h) {
    const b = g.rec.body;
    const t = b.translation(), q = b.rotation();
    const p = g.local.clone().applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w)).add(v3(t));
    const com = v3(b.worldCom()), lv = v3(b.linvel()), av = v3(b.angvel());
    const vel = lv.add(av.cross(p.clone().sub(com)));
    // critically-damped spring, scaled by the mass being moved; capped so it can't explode
    const m = Math.max(b.mass(), this.totalMass * 0.5);
    const w = 14, z = 0.9;
    const f = g.target.clone().sub(p).multiplyScalar(w * w).sub(vel.multiplyScalar(2 * z * w)).multiplyScalar(m * h);
    f.clampLength(0, this.totalMass * 0.6);
    b.applyImpulseAtPoint(f, p, true);
  }
}
