// A procedural office chair with named parts, so the app can be tried without downloading a model.
// Names follow the same conventions a CAD export would: Base, Wheel_n, Seat, Backrest.
import * as THREE from 'three';

export function buildDemoChair() {
  const M = {
    plastic: new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.55, metalness: 0.1 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.25, metalness: 0.9 }),
    fabric: new THREE.MeshStandardMaterial({ color: 0x2f5d8a, roughness: 0.9 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 }),
  };
  const box = (name, w, h, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.name = name; m.position.set(x, y, z); return m; };
  const root = new THREE.Group(); root.name = 'OfficeChair';

  const base = new THREE.Group(); base.name = 'Base';
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * Math.PI * 2;
    const leg = box('Leg_' + (i + 1), 0.05, 0.035, 0.32, M.metal, Math.sin(a) * 0.16, 0.09, Math.cos(a) * 0.16);
    leg.rotation.y = a; base.add(leg);
    const fork = box('Fork_' + (i + 1), 0.035, 0.03, 0.04, M.plastic, Math.sin(a) * 0.31, 0.065, Math.cos(a) * 0.31);
    base.add(fork);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.025, 20), M.rubber);
    wheel.rotation.z = Math.PI / 2;           // axle along x
    const wg = new THREE.Group(); wg.name = 'Wheel_' + (i + 1);
    wg.position.set(Math.sin(a) * 0.31, 0.03, Math.cos(a) * 0.31);
    wg.add(wheel); base.add(wg);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.06, 20), M.metal); hub.name = 'Hub'; hub.position.y = 0.09; base.add(hub);
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.34, 16), M.metal); col.name = 'GasLift'; col.position.y = 0.28; base.add(col);
  root.add(base);

  const seat = new THREE.Group(); seat.name = 'Seat';
  seat.add(box('Cushion', 0.48, 0.07, 0.46, M.fabric, 0, 0.49, 0));
  seat.add(box('Pan', 0.42, 0.03, 0.4, M.plastic, 0, 0.445, 0));
  for (const s of [-1, 1]) {
    seat.add(box(s < 0 ? 'ArmPost_L' : 'ArmPost_R', 0.03, 0.18, 0.03, M.plastic, s * 0.25, 0.58, 0.0));
    seat.add(box(s < 0 ? 'ArmPad_L' : 'ArmPad_R', 0.06, 0.03, 0.25, M.plastic, s * 0.25, 0.68, 0.02));
  }
  const backrest = new THREE.Group(); backrest.name = 'Backrest';
  const pad = box('Pad', 0.44, 0.5, 0.06, M.fabric, 0, 0.83, -0.25); pad.rotation.x = -0.12;
  backrest.add(pad, box('Spine', 0.06, 0.25, 0.03, M.plastic, 0, 0.58, -0.25));
  seat.add(backrest);
  root.add(seat);
  return root;
}
