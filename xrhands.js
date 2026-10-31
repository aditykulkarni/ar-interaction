// Hand tracking inside WebXR AR (Chrome on Android).
// 1. Raw Camera Access ('camera-access') gives the AR camera image as a WebGL texture each frame.
// 2. We copy it into a small render target, read the pixels back and run MediaPipe Hands on them.
// 3. Each 2D landmark becomes a ray from the phone camera. Its distance comes from the depth sensor
//    ('depth-sensing', when the phone has one) or, failing that, from the size of the hand in the image.
// Result: 21 points per hand in AR world coordinates (metres), in the same space as the placed object.
import * as THREE from 'three';

const READ_W = 256;
// physical size used when there is no depth sensor: wrist -> middle-finger knuckle, metres
const DEFAULT_PALM = 0.09;

export class XRHands {
  constructor(renderer) {
    this.renderer = renderer;
    this.camTex = new THREE.Texture();
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { map: { value: this.camTex } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main(){ gl_FragColor = texture2D(map, vUv); }',
      depthTest: false, depthWrite: false, toneMapped: false,
    })));
    this.rt = null; this.buf = null; this.img = null;
    this.prev = new Map();       // smoothing per hand
    this.status = 'off';
    this.frameNo = 0;
  }

  start(session, landmarker) {
    this.session = session;
    this.landmarker = landmarker;
    const feats = session.enabledFeatures;
    this.hasCamera = !feats || feats.includes('camera-access');
    this.hasDepth = !!feats && feats.includes('depth-sensing') && session.depthUsage === 'cpu-optimized';
    try { this.binding = new XRWebGLBinding(session, this.renderer.getContext()); } catch { this.binding = null; this.hasCamera = false; }
    this.status = this.hasCamera ? 'waiting' : 'no-camera';
    this.prev.clear();
  }
  stop() { this.session = null; this.status = 'off'; this.prev.clear(); }

  /** Returns [{ id, pts: Vector3[21], pinch, pinchPoint, depthSource }] or null when no camera image */
  update(frame, refSpace) {
    if (!this.session || !this.hasCamera || !this.landmarker) return null;
    const pose = frame.getViewerPose(refSpace);
    const view = pose?.views?.[0];
    if (!view?.camera) { this.status = 'no-camera'; return null; }
    let glTex;
    try { glTex = this.binding.getCameraImage(view.camera); } catch (e) { this.status = 'no-camera'; return null; }
    if (!glTex) return null;
    this.frameNo++;

    // ---- copy the camera texture into a small RGBA image
    const w = READ_W, h = Math.max(8, Math.round(READ_W * view.camera.height / view.camera.width));
    if (!this.rt || this.rt.width !== w || this.rt.height !== h) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
      this.buf = new Uint8Array(w * h * 4);
      this.img = new ImageData(w, h);
    }
    const r = this.renderer, props = r.properties.get(this.camTex);
    props.__webglTexture = glTex; props.__webglInit = true;
    const prevTarget = r.getRenderTarget(), xrWas = r.xr.enabled;
    r.xr.enabled = false;
    r.setRenderTarget(this.rt);
    r.render(this.quadScene, this.quadCam);
    r.readRenderTargetPixels(this.rt, 0, 0, w, h, this.buf);
    r.setRenderTarget(prevTarget);
    r.xr.enabled = xrWas;
    // GL rows are bottom-up; ImageData is top-down
    const row = w * 4, dst = this.img.data;
    for (let y = 0; y < h; y++) dst.set(this.buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);

    // ---- detect
    let res;
    try { res = this.landmarker.detectForVideo(this.img, performance.now()); } catch (e) { this.status = 'error: ' + e.message; return []; }
    const depthInfo = this.hasDepth ? safe(() => frame.getDepthInformation(view)) : null;
    this.status = depthInfo ? 'tracking (depth sensor)' : 'tracking (estimated depth)';

    // ---- 2D -> 3D
    const invProj = new THREE.Matrix4().fromArray(view.projectionMatrix).invert();
    const viewM = new THREE.Matrix4().fromArray(view.transform.matrix);
    const origin = new THREE.Vector3().setFromMatrixPosition(viewM);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(viewM);
    const rayDir = (u, v) => new THREE.Vector3(u * 2 - 1, 1 - v * 2, 1).applyMatrix4(invProj).normalize().transformDirection(viewM);

    const out = [];
    const seen = new Set();
    (res.landmarks || []).forEach((lm, i) => {
      const id = res.handednesses?.[i]?.[0]?.categoryName || 'hand' + i;
      seen.add(id);
      const wl = res.worldLandmarks?.[i];
      const dirs = lm.map(p => rayDir(p.x, p.y));
      // distance to the palm centre
      let dist = null, source = 'estimated';
      if (depthInfo) {
        const ds = [0, 5, 9, 13, 17].map(k => safe(() => depthInfo.getDepthInMeters(clamp01(lm[k].x), clamp01(lm[k].y)))).filter(d => d > 0.1 && d < 4).sort((a, b) => a - b);
        if (ds.length >= 2) {
          const zDepth = ds[Math.floor(ds.length / 2)];
          dist = zDepth / Math.max(0.2, dirs[9].dot(fwd));     // depth is along the view axis; convert to ray length
          source = 'depth';
        }
      }
      if (dist == null) {
        const L = wl ? Math.hypot(wl[0].x - wl[9].x, wl[0].y - wl[9].y, wl[0].z - wl[9].z) || DEFAULT_PALM : DEFAULT_PALM;
        const angle = dirs[0].angleTo(dirs[9]);
        dist = THREE.MathUtils.clamp(L / Math.max(angle, 1e-3), 0.12, 3);
      }
      // per-landmark distance: palm distance + relative depth from the model's 3D hand
      const pts = dirs.map((d, k) => {
        const dz = wl ? (wl[k].z - wl[9].z) : 0;
        return origin.clone().addScaledVector(d, dist + dz);
      });
      // smooth jitter (stronger when the hand is still)
      const prev = this.prev.get(id);
      if (prev) for (let k = 0; k < 21; k++) {
        const jump = prev[k].distanceTo(pts[k]);
        if (jump < 0.2) pts[k].lerpVectors(prev[k], pts[k], jump < 0.01 ? 0.35 : 0.7);
      }
      this.prev.set(id, pts.map(p => p.clone()));
      const pd = pts[4].distanceTo(pts[8]);
      const was = this.pinchState?.[id] || false;
      const pinch = was ? pd < 0.05 : pd < 0.03;
      (this.pinchState ||= {})[id] = pinch;
      out.push({ id, pts, pinch, pinchPoint: pts[4].clone().lerp(pts[8], 0.5), origin, depthSource: source, size: dist });
    });
    for (const id of [...this.prev.keys()]) if (!seen.has(id)) this.prev.delete(id);
    return out;
  }
}

function safe(f) { try { return f(); } catch { return null; } }
function clamp01(v) { return Math.min(0.999, Math.max(0.001, v)); }
